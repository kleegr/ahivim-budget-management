import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasTestDatabase, testPool, resetSchema, truncateBusinessTables, closeTestPool } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { listTransactionsForGrid } from "@/lib/data/transactions-grid";
import { computeGridTotals } from "@/lib/business/transaction-totals";
import { closeEnough } from "@/lib/money";

// The row-level fixture is derived from the client's workbook and contains real
// payroll PII (names, amounts, check numbers), so it is NOT committed. Generate
// it locally with `python3 tests/fixtures/build-workbook-parity.py <wb>.xlsx`
// alongside a small companion export, or from the workbook directly. When it is
// absent the suite skips cleanly; `workbook-parity.json` (aggregates only, no
// per-person rows) is committed and drives the expected totals.
type Row = (string | number | null)[];
const rowsPath = fileURLToPath(new URL("../fixtures/ahivim-rows.json", import.meta.url));
const hasRowFixture = existsSync(rowsPath);
const suite = hasTestDatabase && hasRowFixture ? describe : describe.skip;
let pool: PgLikePool;
let rowsFx: { fields: string[]; rows: Row[] };
let F: Record<string, number>;

const parity = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/workbook-parity.json", import.meta.url)), "utf8")) as {
  ahivim: {
    totals: { gross: string; internal: string; agencyAdditional: string; netOnce: string; transactions: number; checks: number; individuals: number; employees: number };
    byProgram: Record<string, { gross: string; internal: string; agencyAdditional: string; netOnce: string; transactions: number; checks: number }>;
  };
};

async function loadWorkbook() {
  // Bulk-insert all rows in one round-trip via UNNEST. Only raw import fields +
  // the workbook's own internal amount (column P) are stored — exactly what a
  // real import captures — so the grid must derive gross/internal/
  // agency-additional and unique-check net pay itself.
  const col = (name: string) => rowsFx.rows.map((r) => r[F[name]]);
  const fingerprints = rowsFx.rows.map((_, i) => `wb-${i}`);
  await pool.query(
    `INSERT INTO payroll_transactions
       (check_number, imported_amount, spreadsheet_internal_amount, total_net_pay,
        individual_raw, employee_raw, program_raw, transaction_fingerprint)
     SELECT * FROM unnest(
       $1::text[], $2::numeric[], $3::numeric[], $4::numeric[],
       $5::text[], $6::text[], $7::text[], $8::text[])`,
    [
      col("checkNumber"), col("gross"), col("internal"), col("totalNetPay"),
      col("individual"), col("employee"), col("program"), fingerprints,
    ],
  );
}

suite("Transactions workspace — workbook parity at full scale (3,069 rows)", () => {
  beforeAll(async () => {
    rowsFx = JSON.parse(readFileSync(rowsPath, "utf8")) as { fields: string[]; rows: Row[] };
    F = Object.fromEntries(rowsFx.fields.map((n, i) => [n, i]));
    await resetSchema();
    pool = testPool();
    await truncateBusinessTables();
    await loadWorkbook();
  }, 120_000);
  afterAll(closeTestPool);

  it("represents every one of the 3,069 workbook rows", async () => {
    const rows = await listTransactionsForGrid(pool);
    expect(rows).toHaveLength(3069);
    expect(rows.length).toBe(parity.ahivim.totals.transactions);
  });

  it("reproduces the workbook's full unfiltered totals exactly", async () => {
    const rows = await listTransactionsForGrid(pool);
    const t = computeGridTotals(rows);
    const w = parity.ahivim.totals;
    expect(closeEnough(t.gross, w.gross, "0.01")).toBe(true); // 1,575,583.05
    expect(closeEnough(t.internal, w.internal, "0.01")).toBe(true); // 1,430,370.96
    expect(closeEnough(t.agencyAdditional, w.agencyAdditional, "0.01")).toBe(true); // 145,212.09 = gross − internal
    expect(closeEnough(t.netPerCheck, w.netOnce, "0.01")).toBe(true); // 1,516,250.51 — counted once per check
    expect(t.checks).toBe(w.checks); // 447
    expect(t.individuals).toBe(w.individuals); // 34
    expect(t.employees).toBe(w.employees); // 24
  });

  it("counts Total Net Pay once per check (not per row): the deduped total is far below the row-sum", async () => {
    const rows = await listTransactionsForGrid(pool);
    const rowSum = rows.reduce((s, r) => s + Number(r.totalNetPay ?? 0), 0);
    const t = computeGridTotals(rows);
    expect(Number(t.netPerCheck)).toBeLessThan(rowSum); // dedup actually removed repeats
    expect(closeEnough(t.netPerCheck, parity.ahivim.totals.netOnce, "0.01")).toBe(true);
  });

  it("reproduces filtered totals for every program (filter → SUBTOTAL parity)", async () => {
    const all = await listTransactionsForGrid(pool);
    const failures: string[] = [];
    for (const [program, w] of Object.entries(parity.ahivim.byProgram)) {
      const filtered = all.filter((r) => r.program === program);
      const t = computeGridTotals(filtered);
      if (!closeEnough(t.gross, w.gross, "0.01")) failures.push(`${program}: gross ${t.gross} vs ${w.gross}`);
      if (!closeEnough(t.internal, w.internal, "0.01")) failures.push(`${program}: internal ${t.internal} vs ${w.internal}`);
      if (!closeEnough(t.agencyAdditional, w.agencyAdditional, "0.01")) failures.push(`${program}: agencyAdditional`);
      if (t.transactions !== w.transactions) failures.push(`${program}: tx ${t.transactions} vs ${w.transactions}`);
      if (t.checks !== w.checks) failures.push(`${program}: checks ${t.checks} vs ${w.checks}`);
    }
    expect(failures).toEqual([]);
  });

  it("filters to a single check and totals just that check's rows", async () => {
    const all = await listTransactionsForGrid(pool);
    const someCheck = all.find((r) => r.checkNumber)!.checkNumber!;
    const filtered = all.filter((r) => r.checkNumber === someCheck);
    const t = computeGridTotals(filtered);
    expect(t.checks).toBe(1);
    // net counted once even though multiple rows share the check
    const net = filtered[0]!.totalNetPay;
    if (net) expect(closeEnough(t.netPerCheck, net, "0.01")).toBe(true);
  });
});
