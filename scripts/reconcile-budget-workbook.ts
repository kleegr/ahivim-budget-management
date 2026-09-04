/**
 * Conservative Budget workbook recovery CLI.
 *
 * Dry-run (default):
 *   npm run budget:reconcile -- --file "work/source-audit/Budget copy.xlsx"
 *
 * Apply to an explicitly disposable TEST_DATABASE_URL only:
 *   npm run budget:reconcile -- --file "..." --apply --confirm-disposable
 *
 * JSON is written to stdout and, when --out is supplied, to that file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Pool } from "pg";
import { parseBudgetWorkbook } from "../src/lib/excel/parse-budget-workbook";
import type { PgLikePool } from "../src/lib/import/commit";
import { reconcileBudgetWorkbook } from "../src/lib/import/budget-workbook";

interface CliOptions {
  file: string;
  out: string | null;
  apply: boolean;
  confirmDisposable: boolean;
  actorId: string | null;
  asOfDate: string | null;
}

function usage(): string {
  return [
    "Usage: npm run budget:reconcile -- --file <Budget.xlsx> [options]",
    "",
    "Options:",
    "  --out <report.json>       Also save the machine-readable report.",
    "  --as-of <YYYY-MM-DD>      Business date for historical classification.",
    "  --actor-id <uuid>         Optional audit actor (must exist in users).",
    "  --apply                   Insert only unequivocally missing records.",
    "  --confirm-disposable      Required with --apply.",
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
    asOfDate: null,
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
    } else if (arg === "--as-of") {
      options.asOfDate = nextValue(args, index, arg);
      index += 1;
    } else if (arg === "--actor-id") {
      options.actorId = nextValue(args, index, arg);
      index += 1;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--confirm-disposable") {
      options.confirmDisposable = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.file) throw new Error("--file is required.");
  if (options.apply && !options.confirmDisposable) {
    throw new Error("--apply requires --confirm-disposable.");
  }
  if (options.actorId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.actorId)) {
    throw new Error("--actor-id must be a UUID.");
  }
  return options;
}

function connectionString(options: CliOptions): string {
  if (options.apply) {
    if (process.env.VERCEL_ENV === "production") {
      throw new Error("Budget workbook apply mode is disabled in a production runtime.");
    }
    const disposable = process.env.TEST_DATABASE_URL?.trim();
    if (!disposable) {
      throw new Error("Apply mode accepts only TEST_DATABASE_URL and requires a disposable database branch.");
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
  const parsed = await parseBudgetWorkbook(bytes, basename(filePath));
  const pool = new Pool({ connectionString: connectionString(options), max: 2 });
  try {
    const report = await reconcileBudgetWorkbook(pool as unknown as PgLikePool, parsed, {
      apply: options.apply,
      actorId: options.actorId,
      ...(options.asOfDate ? { asOfDate: options.asOfDate } : {}),
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
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
