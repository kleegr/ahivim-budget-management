import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasTestDatabase, testPool, resetSchema, closeTestPool } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { normalizePersonName } from "@/lib/business/name-matching";
import { getIndividualReport } from "@/lib/data/queries";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import { getDashboardData, listTransactions } from "@/lib/data/app-queries";
import { listAliases } from "@/lib/manage/aliases";
import { scanMatches } from "@/lib/manage/individual-merge";

/**
 * Performance guard on the production-sized dataset (all 3,069 workbook rows).
 * Uses the real (gitignored) row fixture; skips cleanly when it is absent.
 * Times the loaders behind the pages that were slow and asserts each stays well
 * under the serverless budget, catching any pathological query regressions.
 */
const rowsPath = fileURLToPath(new URL("../fixtures/ahivim-rows.json", import.meta.url));
const hasFixture = existsSync(rowsPath);
const suite = hasTestDatabase && hasFixture ? describe : describe.skip;

type Row = (string | number | null)[];
let pool: PgLikePool;

const PROGRAM_CODE: Record<string, string> = {
  "Com Hab": "COM_HAB",
  Respite: "RESPITE",
  "Day Hab": "DAY_HAB",
  "SD - Self Hired Com Hab": "SH_COM_HAB",
  "SD - Self Hired Respite": "SH_RESPITE",
  "Supplemental Group Day Hab": "SUPP_GROUP_DAY_HAB",
};

async function time<T>(label: string, fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // eslint-disable-next-line no-console
  console.log(`  ⏱  ${label}: ${ms.toFixed(0)} ms`);
  return { ms, value };
}

suite("performance on the production-sized dataset (3,069 rows)", () => {
  let busiestIndividualId = "";

  beforeAll(async () => {
    await resetSchema();
    pool = testPool();

    const fx = JSON.parse(readFileSync(rowsPath, "utf8")) as { fields: string[]; rows: Row[] };
    const F = Object.fromEntries(fx.fields.map((n, i) => [n, i])) as Record<string, number>;

    // Programs + rate schedules are seeded by migrations. Resolve program ids by code.
    const progRes = await pool.query<{ code: string; id: string }>(`SELECT code, id FROM programs`);
    const progByCode = new Map(progRes.rows.map((r) => [r.code, r.id]));

    // Create every distinct transaction individual (ON CONFLICT keeps the seeded ones).
    const names = [...new Set(fx.rows.map((r) => String(r[F.individual] ?? "")).filter(Boolean))];
    for (const name of names) {
      await pool.query(
        `INSERT INTO individuals (normalized_name, display_name, status) VALUES ($1,$2,'active')
         ON CONFLICT (normalized_name) DO NOTHING`,
        [normalizePersonName(name), name],
      );
    }
    const indRes = await pool.query<{ normalized_name: string; id: string }>(`SELECT normalized_name, id FROM individuals`);
    const indByNorm = new Map(indRes.rows.map((r) => [r.normalized_name, r.id]));

    // Bulk insert the 3,069 transactions with resolved individual_id + program_id.
    const col = (n: string) => fx.rows.map((r) => r[F[n]]);
    const indIds = fx.rows.map((r) => indByNorm.get(normalizePersonName(String(r[F.individual] ?? ""))) ?? null);
    const progIds = fx.rows.map((r) => progByCode.get(PROGRAM_CODE[String(r[F.program] ?? "")] ?? "") ?? null);
    const fps = fx.rows.map((_, i) => `perf-${i}`);
    await pool.query(
      `INSERT INTO payroll_transactions
         (individual_id, program_id, check_number, imported_amount, spreadsheet_internal_amount,
          imported_hours, total_net_pay, individual_raw, employee_raw, program_raw, transaction_fingerprint)
       SELECT * FROM unnest(
         $1::uuid[], $2::uuid[], $3::text[], $4::numeric[], $5::numeric[],
         $6::numeric[], $7::numeric[], $8::text[], $9::text[], $10::text[], $11::text[])`,
      [
        indIds, progIds, col("checkNumber"), col("gross"), col("internal"),
        // no per-row hours in the 7-field fixture → derive a nominal 1h so aggregates run
        fx.rows.map(() => "1"), col("totalNetPay"), col("individual"), col("employee"), col("program"), fps,
      ],
    );

    const busiest = await pool.query<{ id: string }>(
      `SELECT individual_id AS id FROM payroll_transactions WHERE individual_id IS NOT NULL
       GROUP BY individual_id ORDER BY count(*) DESC LIMIT 1`,
    );
    busiestIndividualId = busiest.rows[0]!.id;

    await scanMatches(pool, null); // realistic: merges applied
  }, 120_000);

  afterAll(closeTestPool);

  it("loads the individual report quickly", async () => {
    const { ms } = await time("getIndividualReport (busiest)", () => getIndividualReport(pool, busiestIndividualId));
    expect(ms).toBeLessThan(3000);
  });

  it("loads the Calculations grid (with analytics) quickly", async () => {
    const { ms, value } = await time("listStrategies withAnalytics", () => listStrategies(pool, { withAnalytics: true }));
    expect(value.rows.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(3000);
  });

  it("loads the dashboard quickly", async () => {
    const { ms } = await time("getDashboardData", () => getDashboardData(pool));
    expect(ms).toBeLessThan(3000);
  });

  it("loads the aliases list quickly", async () => {
    const { ms } = await time("listAliases", () => listAliases(pool, {}));
    expect(ms).toBeLessThan(3000);
  });

  it("loads a filtered transactions page quickly", async () => {
    const { ms } = await time("listTransactions (filtered)", () => listTransactions(pool, { limit: 100 }));
    expect(ms).toBeLessThan(3000);
  });
});
