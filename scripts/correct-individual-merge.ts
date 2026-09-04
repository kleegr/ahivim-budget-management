/**
 * Guarded, dry-run-first correction for one proven incorrect individual merge.
 * Apply mode deliberately accepts its connection only from the dedicated
 * CORRECTION_DATABASE_URL variable and requires the audit ID to be repeated as
 * an explicit confirmation token.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import type { PgLikePool } from "../src/lib/import/commit";
import {
  reconcileIncorrectIndividualMerge,
  type IndividualMergeCorrectionInput,
} from "../src/lib/manage/individual-merge-correction";

interface CliOptions extends IndividualMergeCorrectionInput {
  apply: boolean;
  actorId: string | null;
  confirmationAuditId: string | null;
  out: string | null;
  pretty: boolean;
}

function usage(): string {
  return [
    "Usage: npm run individual-merge:correct -- [required options]",
    "",
    "Required:",
    "  --merge-audit-id <uuid>   Exact individuals_merged audit row.",
    "  --folded-id <uuid>        Archived individual to restore.",
    "  --survivor-id <uuid>      Individual that incorrectly received the rows.",
    "  --folded-name <text>      Exact current folded display name.",
    "  --survivor-name <text>    Exact current survivor display name.",
    "  --source-name <text>      Exact transaction source spelling for the folded person.",
    "  --reason <text>           Specific reason for the correction audit.",
    "",
    "Options:",
    "  --out <report.json>       Also save the JSON report.",
    "  --pretty                  Pretty-print JSON; default is compact.",
    "  --apply                   Apply only when every provenance guard passes.",
    "  --actor-id <uuid>         Required with --apply; must identify the operator.",
    "  --confirm-audit-id <uuid> Required with --apply and must repeat --merge-audit-id.",
    "  --help                    Show this help.",
    "",
    "Dry-run reads the first configured database URL. Apply reads only",
    "CORRECTION_DATABASE_URL and is disabled inside a Vercel production runtime.",
  ].join("\n");
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    mergeAuditLogId: "",
    foldedId: "",
    survivorId: "",
    expectedFoldedName: "",
    expectedSurvivorName: "",
    evidenceSourceName: "",
    reason: "",
    apply: false,
    actorId: null,
    confirmationAuditId: null,
    out: null,
    pretty: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (flag === "--apply") options.apply = true;
    else if (flag === "--pretty") options.pretty = true;
    else if (flag === "--merge-audit-id") options.mergeAuditLogId = nextValue(args, index++, flag);
    else if (flag === "--folded-id") options.foldedId = nextValue(args, index++, flag);
    else if (flag === "--survivor-id") options.survivorId = nextValue(args, index++, flag);
    else if (flag === "--folded-name") options.expectedFoldedName = nextValue(args, index++, flag);
    else if (flag === "--survivor-name") options.expectedSurvivorName = nextValue(args, index++, flag);
    else if (flag === "--source-name") options.evidenceSourceName = nextValue(args, index++, flag);
    else if (flag === "--reason") options.reason = nextValue(args, index++, flag);
    else if (flag === "--actor-id") options.actorId = nextValue(args, index++, flag);
    else if (flag === "--confirm-audit-id") options.confirmationAuditId = nextValue(args, index++, flag);
    else if (flag === "--out") options.out = nextValue(args, index++, flag);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (options.apply) {
    if (options.confirmationAuditId !== options.mergeAuditLogId) {
      throw new Error("--confirm-audit-id must exactly repeat --merge-audit-id.");
    }
    if (!options.actorId) throw new Error("--apply requires --actor-id.");
  }
  return options;
}

function connectionString(options: CliOptions): string {
  if (options.apply) {
    if (process.env.VERCEL_ENV === "production") {
      throw new Error("Individual merge correction is disabled inside a production runtime.");
    }
    const explicit = process.env.CORRECTION_DATABASE_URL?.trim();
    if (!explicit) {
      throw new Error("Apply mode accepts only the explicitly set CORRECTION_DATABASE_URL.");
    }
    return explicit;
  }
  const candidates = [
    process.env.CORRECTION_DATABASE_URL,
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.DATABASE_URL_UNPOOLED,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.POSTGRES_PRISMA_URL,
    process.env.NEON_DATABASE_URL,
  ];
  const value = candidates.find((candidate) => candidate?.trim());
  if (!value) throw new Error("No database connection variable was found for the dry run.");
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: connectionString(options), max: 1 });
  try {
    const report = await reconcileIncorrectIndividualMerge(
      pool as unknown as PgLikePool,
      {
        mergeAuditLogId: options.mergeAuditLogId,
        foldedId: options.foldedId,
        survivorId: options.survivorId,
        expectedFoldedName: options.expectedFoldedName,
        expectedSurvivorName: options.expectedSurvivorName,
        evidenceSourceName: options.evidenceSourceName,
        reason: options.reason,
      },
      { apply: options.apply, actorId: options.actorId },
    );
    const output = `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`;
    if (options.out) {
      const path = resolve(options.out);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, output, "utf8");
    }
    process.stdout.write(output);
    if (report.outcome === "blocked") process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
});
