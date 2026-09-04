/**
 * Conservative transaction-workbook reconciliation CLI.
 *
 * Dry run (default):
 *   npm run transaction:reconcile -- --file "work/source-audit/live-transaction-feed.xlsx"
 *
 * Apply to an explicitly disposable TEST_DATABASE_URL only:
 *   npm run transaction:reconcile -- --file "..." --apply --confirm-disposable
 *
 * Apply mode still writes only unequivocally missing transactions. Exact rows
 * are no-ops; repeats, changes, unresolved identities, and historical rows are
 * preserved without automatic insertion, replacement, or deletion.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { Pool } from "pg";
import { fileChecksum } from "../src/lib/business/fingerprint";
import { parseWorkbook } from "../src/lib/excel/parse-workbook";
import type { PgLikePool } from "../src/lib/import/commit";
import { reconcileTransactionWorkbook } from "../src/lib/import/transaction-workbook";

interface CliOptions {
  file: string;
  out: string | null;
  apply: boolean;
  confirmDisposable: boolean;
  actorId: string | null;
  pretty: boolean;
}

function usage(): string {
  return [
    "Usage: npm run transaction:reconcile -- --file <Transactions.xlsx> [options]",
    "",
    "Options:",
    "  --out <report.json>       Also save the machine-readable report.",
    "  --actor-id <uuid>         Optional audit actor (must exist in users).",
    "  --apply                   Insert only unequivocally missing transactions.",
    "  --confirm-disposable      Required with --apply; apply uses TEST_DATABASE_URL only.",
    "  --pretty                  Pretty-print JSON instead of compact one-line JSON.",
    "  --help                    Show this help.",
  ].join("\n");
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    file: "",
    out: null,
    apply: false,
    confirmDisposable: false,
    actorId: null,
    pretty: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else if (arg === "--file") {
      options.file = nextValue(args, index, arg);
      index += 1;
    } else if (arg === "--out") {
      options.out = nextValue(args, index, arg);
      index += 1;
    } else if (arg === "--actor-id") {
      options.actorId = nextValue(args, index, arg);
      index += 1;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--confirm-disposable") {
      options.confirmDisposable = true;
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.file) throw new Error("--file is required.");
  if (extname(options.file).toLowerCase() !== ".xlsx") {
    throw new Error("--file must point to an .xlsx transaction workbook.");
  }
  if (options.apply && !options.confirmDisposable) {
    throw new Error("--apply requires --confirm-disposable.");
  }
  if (
    options.actorId
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.actorId)
  ) {
    throw new Error("--actor-id must be a UUID.");
  }
  return options;
}

function connectionString(options: CliOptions): string {
  if (options.apply) {
    if (process.env.VERCEL_ENV === "production") {
      throw new Error("Transaction recovery apply mode is disabled in a production runtime.");
    }
    const disposable = process.env.TEST_DATABASE_URL?.trim();
    if (!disposable) {
      throw new Error(
        "Apply mode accepts only TEST_DATABASE_URL and requires a disposable database branch.",
      );
    }
    return disposable;
  }
  const candidates = [
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.DATABASE_URL_UNPOOLED,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.POSTGRES_PRISMA_URL,
    process.env.NEON_DATABASE_URL,
  ];
  const value = candidates.find((candidate) => candidate?.trim());
  if (!value) throw new Error("No database connection variable was found for reconciliation.");
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const filePath = resolve(options.file);
  const bytes = await readFile(filePath);
  const parsed = await parseWorkbook(bytes);
  const pool = new Pool({ connectionString: connectionString(options), max: 2 });
  try {
    const report = await reconcileTransactionWorkbook(
      pool as unknown as PgLikePool,
      parsed,
      {
        fileName: basename(filePath),
        byteSize: bytes.byteLength,
        checksumSha256: fileChecksum(bytes),
      },
      { apply: options.apply, actorId: options.actorId },
    );
    const json = `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`;
    if (options.out) {
      const outputPath = resolve(options.out);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, json, "utf8");
    }
    process.stdout.write(json);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exit(1);
});
