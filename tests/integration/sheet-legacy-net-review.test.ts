import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SYNC_CONFIG } from "@/lib/sheets/config";
import { sheetValuesToCsv } from "@/lib/sheets/fetch";
import { sourceEvidenceKey } from "@/lib/sheets/identity";
import { parseSheetCsv } from "@/lib/sheets/parse-csv";
import { dismissConflict } from "@/lib/sheets/resolve";
import { runSheetSync } from "@/lib/sheets/sync";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";
import { numericSheetFixture } from "../support/sheet-numeric-fixture";

const suite = hasTestDatabase ? describe : describe.skip;

suite("Legacy unknown NET remains actionable after a source evidence upgrade", () => {
  beforeEach(resetSchema, 60_000);
  afterAll(closeTestPool);

  for (const { shape, net } of [
    { shape: "legacy", net: "3172.0300" },
    { shape: "already-bootstrapped", net: "3172.0300" },
    { shape: "already-bootstrapped", net: "0.0000" },
  ] as const) {
    it(`holds recovered NET ${net} for ${shape} tracking without changing money or duplicating later syncs`, async () => {
      const pool = testPool();
      const fixture = await numericSheetFixture();
      const sync = (csv: string) => runSheetSync(pool, {
        trigger: "manual", userId: null, config: DEFAULT_SYNC_CONFIG, fetcher: async () => csv,
      });
      expect(await sync(fixture.csv)).toMatchObject({ status: "success", added: 2 });
      const transactionId = (await pool.query<{ id: string }>(
        "SELECT id FROM payroll_transactions WHERE check_number = 'NUMERIC-SOURCE-1'",
      )).rows[0]!.id;
      await pool.query("UPDATE payroll_transactions SET is_paid = true, paid_note = 'App-owned partial tracking' WHERE id = $1", [transactionId]);
      // Exact historical shape: canonical identity and source Paid, without any NET/routing evidence.
      await pool.query(`UPDATE sheet_sync_rows SET identity = identity
        - 'totalNetPay' - 'payTo' - 'sourceEvidenceKeyVersion' - 'sourceEvidenceKeys'
        - 'sourceEvidenceVariants' - 'sourceRowNumbers' - 'sourceOccurrenceCount'`);
      const recovered = fixture.values.map(row => [...row]);
      recovered[3]![7] = net;
      const recoveredCsv = sheetValuesToCsv(recovered);
      if (shape === "already-bootstrapped") {
        // The prior release silently stored new source evidence while retaining canonical NULL NET.
        const identity = { payTo: recovered[3]![0], totalNetPay: net };
        await pool.query(`UPDATE sheet_sync_rows SET identity = identity || $2::jsonb
          WHERE payroll_transaction_id = $1`, [transactionId, JSON.stringify({
          ...identity, sourceEvidenceKeyVersion: "v2", sourceEvidenceKeys: [sourceEvidenceKey(identity)],
        })]);
      }
      await pool.query(`UPDATE sheet_sync_runs SET snapshot_sha256 = $1,
        reconciliation = reconciliation || '{"sourceTrackingVersion":"occurrence-v1+source-evidence-v2"}'::jsonb
        WHERE status = 'success'`, [parseSheetCsv(shape === "already-bootstrapped" ? recoveredCsv : fixture.csv).snapshotSha256]);

      const controls = async () => (await pool.query(`SELECT
        (SELECT count(*)::int FROM payroll_transactions) AS transactions,
        (SELECT count(*)::int FROM employee_payroll_checks) AS checks,
        (SELECT count(*)::int FROM settlement_obligations) AS obligations,
        (SELECT count(*)::int FROM settlement_events) AS events,
        (SELECT md5(string_agg(jsonb_build_array(id, imported_amount, total_net_pay, is_paid, paid_note)::text, '' ORDER BY id))
           FROM payroll_transactions) AS money_and_paid_hash`)).rows[0];
      const before = await controls();
      expect(before).toMatchObject({ transactions: 2, checks: 0, obligations: 0, events: 0 });
      const first = await sync(recoveredCsv);
      expect(first).toMatchObject({ status: "success", added: 0, changed: 1, flagged: 1, failed: 0 });
      const reviews = await pool.query<{ id: string; previous_net: string | null; incoming_net: string; marker: string }>(
        `SELECT id, previous->>'totalNetPay' AS previous_net, incoming->>'totalNetPay' AS incoming_net,
                previous->>'sourceEvidenceConflict' AS marker
         FROM sheet_sync_conflicts WHERE status = 'open'`,
      );
      expect(reviews.rows).toEqual([{
        id: expect.any(String), previous_net: null, incoming_net: net, marker: "routing_or_net",
      }]);
      expect(await controls()).toEqual(before);
      expect(await sync(recoveredCsv)).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
      expect((await pool.query("SELECT count(*)::int AS count FROM sheet_sync_conflicts")).rows[0]?.count).toBe(1);
      expect(await controls()).toEqual(before);

      expect(await dismissConflict(pool, reviews.rows[0]!.id, null, "Explicitly acknowledged source evidence")).toMatchObject({ ok: true });
      // Force a full read with only the Sheet's non-authoritative Paid display changed.
      recovered[3]![13] = "Paid";
      expect(await sync(sheetValuesToCsv(recovered))).toMatchObject({ status: "success", added: 0, changed: 0 });
      expect((await pool.query("SELECT count(*)::int AS count FROM sheet_sync_conflicts WHERE status = 'open'")).rows[0]?.count).toBe(0);
      expect(await controls()).toEqual(before);

      recovered[3]![7] = "3173.03";
      expect(await sync(sheetValuesToCsv(recovered))).toMatchObject({ status: "success", added: 0, changed: 1 });
      expect((await pool.query("SELECT count(*)::int AS count FROM sheet_sync_conflicts WHERE status = 'open'")).rows[0]?.count).toBe(1);
      expect(await controls()).toEqual(before);
      recovered[3]![7] = net;
      expect(await sync(sheetValuesToCsv(recovered))).toMatchObject({ status: "success", added: 0, changed: 0 });
      expect((await pool.query("SELECT count(*)::int AS count FROM sheet_sync_conflicts WHERE status = 'open'")).rows[0]?.count).toBe(0);
      expect(await controls()).toEqual(before);
    }, 40_000);
  }
});
