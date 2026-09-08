import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SYNC_CONFIG } from "@/lib/sheets/config";
import { fetchSheetCsv } from "@/lib/sheets/fetch";
import { runSheetSync } from "@/lib/sheets/sync";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";
import { numericSheetFixture } from "../support/sheet-numeric-fixture";

const suite = hasTestDatabase ? describe : describe.skip;

suite("Numeric Sheet source replay (PostgreSQL)", () => {
  beforeAll(resetSchema, 60_000);
  afterAll(closeTestPool);

  it("imports recovered source NET once while preserving unknown facts, app Paid state, checks, and obligations", async () => {
    const pool = testPool();
    const fixture = await numericSheetFixture();
    const request = vi.fn<typeof fetch>(async (url) => String(url).includes("format=xlsx")
      ? new Response(new Uint8Array(fixture.bytes)) : new Response(fixture.csv));
    const sync = () => runSheetSync(pool, {
      trigger: "manual", userId: null, config: DEFAULT_SYNC_CONFIG,
      fetcher: (cfg) => fetchSheetCsv(cfg, { credentials: null, request }),
    });
    const first = await sync();
    expect(first).toMatchObject({ status: "success", added: 2, failed: 0 });
    const rows = await pool.query<{ id: string; check_number: string; total_net_pay: string | null }>(
      "SELECT id,check_number,total_net_pay::text FROM payroll_transactions ORDER BY check_number",
    );
    expect(rows.rows).toEqual([
      { id: expect.any(String), check_number: "NUMERIC-SOURCE-1", total_net_pay: "3172.0300" },
      { id: expect.any(String), check_number: "NUMERIC-SOURCE-UNKNOWN", total_net_pay: null },
    ]);
    const counts = async () => (await pool.query(
      `SELECT (SELECT count(*)::int FROM payroll_transactions) AS transactions,
              (SELECT count(*)::int FROM employee_payroll_checks) AS checks,
              (SELECT count(*)::int FROM settlement_obligations) AS obligations,
              (SELECT count(*)::int FROM settlement_events) AS events`,
    )).rows[0];
    const before = await counts();
    expect(before).toEqual({ transactions: 2, checks: 1, obligations: 0, events: 0 });
    await pool.query("UPDATE payroll_transactions SET is_paid = true WHERE id = $1", [rows.rows[0]!.id]);
    const second = await sync();
    expect(second).toMatchObject({ status: "no_changes", added: 0, failed: 0 });
    expect(await counts()).toEqual(before);
    expect((await pool.query("SELECT is_paid FROM payroll_transactions WHERE id = $1", [rows.rows[0]!.id])).rows[0]?.is_paid).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM employee_payroll_checks WHERE verification_status = 'verified'")).rows[0]?.count).toBe(0);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  }, 30_000);
});
