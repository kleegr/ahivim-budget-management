/**
 * Conservative Calculations workbook reconciliation CLI.
 *
 * Dry-run (default):
 *   npm run calculation:reconcile -- --file "work/source-audit/Ahivim Calculations copy.xlsx"
 *
 * Apply to an explicitly disposable TEST_DATABASE_URL only:
 *   npm run calculation:reconcile -- --file "..." --apply --confirm-disposable
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Pool } from "pg";
import { parseCalculationsWorkbook } from "../src/lib/excel/parse-calculations-workbook";
import {
  calculationWorkbookCliUsage,
  calculationWorkbookConnectionString,
  parseCalculationWorkbookCliArgs,
} from "../src/lib/import/calculation-workbook-cli";
import { reconcileCalculationWorkbook } from "../src/lib/import/calculation-workbook";
import type { PgLikePool } from "../src/lib/import/commit";

async function main(): Promise<void> {
  const options = parseCalculationWorkbookCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${calculationWorkbookCliUsage()}\n`);
    return;
  }
  const connectionString = calculationWorkbookConnectionString(options);
  const filePath = resolve(options.file);
  const bytes = await readFile(filePath);
  const parsed = await parseCalculationsWorkbook(bytes, basename(filePath));
  const pool = new Pool({ connectionString, max: 2 });
  try {
    const report = await reconcileCalculationWorkbook(pool as unknown as PgLikePool, parsed, {
      apply: options.apply,
      actorId: options.actorId,
      ...(options.asOf ? { asOf: options.asOf } : {}),
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
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : "Calculations reconciliation failed.",
  }, null, 2)}\n`);
  process.exit(1);
});
