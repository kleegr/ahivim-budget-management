/**
 * One explicit production-only entry point for the four independently tested
 * takeover recoveries. The manifest order is fixed because restoring a proven
 * incorrectly folded identity must precede the source workbook reconciliations.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { Pool } from "pg";
import { fileChecksum } from "../src/lib/business/fingerprint";
import { parseBudgetWorkbook } from "../src/lib/excel/parse-budget-workbook";
import { parseCalculationsWorkbook } from "../src/lib/excel/parse-calculations-workbook";
import { parseWorkbook } from "../src/lib/excel/parse-workbook";
import { reconcileBudgetWorkbook } from "../src/lib/import/budget-workbook";
import { reconcileCalculationWorkbook } from "../src/lib/import/calculation-workbook";
import type { PgLikePool } from "../src/lib/import/commit";
import {
  parseProductionRecoveryCliArgs,
  parseProductionRecoveryManifest,
  productionRecoveryCliUsage,
  productionRecoveryConnectionString,
  productionRecoveryPassModes,
  redactProductionRecoveryError,
  requireProductionRecoverySchemaReady,
  verifyProductionRecoveryControlPlane,
} from "../src/lib/import/production-recovery-cli";
import { reconcileTransactionWorkbook } from "../src/lib/import/transaction-workbook";
import { reconcileIncorrectIndividualMerge } from "../src/lib/manage/individual-merge-correction";

function artifactPath(manifestDirectory: string, path: string): string {
  return isAbsolute(path) ? path : resolve(manifestDirectory, path);
}

function comparablePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

async function requireSafeOutputPath(
  outputPath: string | null,
  sourcePaths: string[],
): Promise<void> {
  const distinctSources = new Set(sourcePaths.map(comparablePath));
  if (distinctSources.size !== sourcePaths.length) {
    throw new Error("The manifest and all three recovery workbooks must be different files.");
  }
  if (!outputPath) return;
  if (distinctSources.has(comparablePath(outputPath))) {
    throw new Error("--out must not replace the manifest or any recovery workbook.");
  }
  try {
    await stat(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("--out already exists; choose a new report path so prior evidence is preserved.");
}

async function requireActiveActor(pool: PgLikePool, actorId: string): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `SELECT id::text
       FROM users
      WHERE id = $1
        AND is_active = true`,
    [actorId],
  );
  if (result.rows.length !== 1) {
    throw new Error("--actor-id must identify one active production user before apply can start.");
  }
}

async function requireDatabaseIdentity(pool: PgLikePool, expectedDatabaseName: string): Promise<void> {
  const result = await pool.query<{
    database_name: string;
    current_schema: string | null;
    in_recovery: boolean;
  }>(
    `SELECT current_database()::text AS database_name,
            current_schema()::text AS current_schema,
            pg_is_in_recovery() AS in_recovery`,
  );
  const identity = result.rows[0];
  if (
    result.rows.length !== 1
    || identity?.database_name !== expectedDatabaseName
    || identity?.current_schema !== "public"
    || identity?.in_recovery !== false
  ) {
    throw new Error(
      "The connected database identity is not the expected writable production database; apply is blocked.",
    );
  }
}

type RecoveryPass = Awaited<ReturnType<typeof runRecoveryPass>>;

async function runRecoveryPass(
  pool: PgLikePool,
  input: {
    mergeOperation: ReturnType<typeof parseProductionRecoveryManifest>["operations"][0];
    budgetOperation: ReturnType<typeof parseProductionRecoveryManifest>["operations"][1];
    calculationsOperation: ReturnType<typeof parseProductionRecoveryManifest>["operations"][2];
    budget: Awaited<ReturnType<typeof parseBudgetWorkbook>>;
    calculations: Awaited<ReturnType<typeof parseCalculationsWorkbook>>;
    transactions: Awaited<ReturnType<typeof parseWorkbook>>;
    transactionsPath: string;
    transactionsBytes: Buffer;
  },
  options: { apply: boolean; actorId: string | null },
) {
  const merge = await reconcileIncorrectIndividualMerge(
    pool,
    {
      mergeAuditLogId: input.mergeOperation.mergeAuditLogId,
      foldedId: input.mergeOperation.foldedId,
      survivorId: input.mergeOperation.survivorId,
      expectedFoldedName: input.mergeOperation.expectedFoldedName,
      expectedSurvivorName: input.mergeOperation.expectedSurvivorName,
      evidenceSourceName: input.mergeOperation.evidenceSourceName,
      reason: input.mergeOperation.reason,
    },
    { apply: options.apply, actorId: options.actorId },
  );
  if (options.apply && merge.outcome !== "applied" && merge.outcome !== "already-applied") {
    throw new Error(`Individual merge correction did not apply: ${merge.blocks.join("; ")}`);
  }

  const budget = await reconcileBudgetWorkbook(pool, input.budget, {
    apply: options.apply,
    actorId: options.actorId,
    ...(input.budgetOperation.asOfDate ? { asOfDate: input.budgetOperation.asOfDate } : {}),
  });
  const calculations = await reconcileCalculationWorkbook(pool, input.calculations, {
    apply: options.apply,
    actorId: options.actorId,
    ...(input.calculationsOperation.asOf ? { asOf: input.calculationsOperation.asOf } : {}),
  });
  const transactions = await reconcileTransactionWorkbook(
    pool,
    input.transactions,
    {
      fileName: basename(input.transactionsPath),
      byteSize: input.transactionsBytes.byteLength,
      checksumSha256: fileChecksum(input.transactionsBytes),
    },
    { apply: options.apply, actorId: options.actorId },
  );
  return { merge, budget, calculations, transactions };
}

function requireCompletePreflight(pass: RecoveryPass): void {
  if (pass.merge.outcome !== "ready" && pass.merge.outcome !== "already-applied") {
    throw new Error(`Production preflight blocked the merge correction: ${pass.merge.blocks.join("; ")}`);
  }
  if (!pass.budget.source.layoutValid) {
    throw new Error("Production preflight rejected the Budget workbook layout.");
  }
  if (!pass.calculations.layoutValid) {
    throw new Error("Production preflight rejected the Calculations workbook layout.");
  }
}

async function main(): Promise<void> {
  const options = parseProductionRecoveryCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${productionRecoveryCliUsage()}\n`);
    return;
  }

  const manifestPath = resolve(options.manifest);
  const manifest = parseProductionRecoveryManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const manifestDirectory = dirname(manifestPath);
  const [mergeOperation, budgetOperation, calculationsOperation, transactionsOperation] = manifest.operations;
  const budgetPath = artifactPath(manifestDirectory, budgetOperation.file);
  const calculationsPath = artifactPath(manifestDirectory, calculationsOperation.file);
  const transactionsPath = artifactPath(manifestDirectory, transactionsOperation.file);
  const outputPath = options.out ? resolve(options.out) : null;
  await requireSafeOutputPath(outputPath, [
    manifestPath,
    budgetPath,
    calculationsPath,
    transactionsPath,
  ]);

  // Parse every artifact before opening the database so malformed or missing
  // source files cannot cause a partially started production run.
  const [budgetBytes, calculationsBytes, transactionsBytes] = await Promise.all([
    readFile(budgetPath),
    readFile(calculationsPath),
    readFile(transactionsPath),
  ]);
  const [budget, calculations, transactions] = await Promise.all([
    parseBudgetWorkbook(budgetBytes, basename(budgetPath)),
    parseCalculationsWorkbook(calculationsBytes, basename(calculationsPath)),
    parseWorkbook(transactionsBytes),
  ]);

  const connectionString = productionRecoveryConnectionString();
  const controlPlane = options.apply
    ? await verifyProductionRecoveryControlPlane({
        connectionString,
        backupBranchId: options.backupBranchId!,
      })
    : null;
  const pool = new Pool({ connectionString, max: 2 });
  const recoveryPool = pool as unknown as PgLikePool;
  try {
    // Required for dry-run as well as apply: a read-only Calculations pass does
    // not touch its apply-only provenance table and therefore cannot prove the
    // schema is safe for the later writes.
    await requireProductionRecoverySchemaReady(recoveryPool);
    if (options.apply) {
      await requireDatabaseIdentity(recoveryPool, controlPlane!.databaseName);
      await requireActiveActor(recoveryPool, options.actorId!);
    }
    const input = {
      mergeOperation,
      budgetOperation,
      calculationsOperation,
      budget,
      calculations,
      transactions,
      transactionsPath,
      transactionsBytes,
    };
    let preflight: RecoveryPass | null = null;
    let completed: RecoveryPass | null = null;
    for (const mode of productionRecoveryPassModes(options.apply)) {
      const pass = await runRecoveryPass(recoveryPool, input, {
        apply: mode === "apply",
        actorId: mode === "apply" ? options.actorId : null,
      });
      if (mode === "dry-run") {
        preflight = pass;
        if (options.apply) requireCompletePreflight(pass);
      } else {
        completed = pass;
      }
    }
    const finalPass = completed ?? preflight!;

    const report = {
      version: 1,
      mode: options.apply ? "apply" : "dry-run",
      manifest: manifestPath,
      actorId: options.apply ? options.actorId : null,
      backupBranchId: options.apply ? options.backupBranchId : null,
      productionBranchId: controlPlane?.productionBranchId ?? null,
      backupCreatedAt: controlPlane?.backupCreatedAt ?? null,
      safeguards: {
        dryRunByDefault: true,
        dedicatedConnectionVariable: "PRODUCTION_RECOVERY_DATABASE_URL",
        exactConfirmationRequired: true,
        activeActorVerifiedBeforeWrites: options.apply,
        directTlsNeonEndpointRequired: true,
        neonControlPlaneVerifiedBeforeConnection: options.apply,
        recoverySchemaVerifiedBeforeServices: true,
        fullReadOnlyPreflightBeforeWrites: options.apply,
        neonBackupVerified: options.apply,
        disposableRecoveryGuardsUnchanged: true,
      },
      preflight: options.apply && preflight ? {
        mergeOutcome: preflight.merge.outcome,
        budgetLayoutValid: preflight.budget.source.layoutValid,
        calculationsLayoutValid: preflight.calculations.layoutValid,
        transactionSourceRows: preflight.transactions.summary.sourceRows,
      } : null,
      operations: [
        { kind: "individual-merge", report: finalPass.merge },
        { kind: "budget", sourceFile: budgetPath, report: finalPass.budget },
        { kind: "calculations", sourceFile: calculationsPath, report: finalPass.calculations },
        { kind: "transactions", sourceFile: transactionsPath, report: finalPass.transactions },
      ],
    };
    const output = `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`;
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, output, { encoding: "utf8", flag: "wx" });
    }
    process.stdout.write(output);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: redactProductionRecoveryError(error),
  })}\n`);
  process.exit(1);
});
