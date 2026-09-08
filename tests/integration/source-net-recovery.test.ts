import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { DEFAULT_SYNC_CONFIG } from "@/lib/sheets/config";
import { sheetValuesToCsv } from "@/lib/sheets/fetch";
import { recoverSourceNet, type SourceNetRecoveryInput } from "@/lib/sheets/net-recovery";
import { listSourceNetRecoveryHistory } from "@/lib/sheets/net-recovery-queries";
import { parseSheetCsv } from "@/lib/sheets/parse-csv";
import { runSheetSync } from "@/lib/sheets/sync";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";
import { numericSheetFixture } from "../support/sheet-numeric-fixture";

const suite = hasTestDatabase ? describe : describe.skip;
suite("Audited recovery of numeric source NET without settlement changes", () => {
  beforeEach(resetSchema, 60_000);
  afterAll(closeTestPool);

  async function setup(net = "3172.0300", edit?: (values: string[][]) => void) {
    const pool = testPool();
    const fixture = await numericSheetFixture();
    expect(await runSheetSync(pool, { trigger: "manual", userId: null, config: DEFAULT_SYNC_CONFIG, fetcher: async () => fixture.csv }))
      .toMatchObject({ status: "success", added: 2 });
    await pool.query(`UPDATE payroll_transactions SET is_paid = true, paid_note = 'Application-owned paid state'
      WHERE check_number = 'NUMERIC-SOURCE-1'`);
    await pool.query(`UPDATE sheet_sync_rows SET identity = identity
      - 'totalNetPay' - 'payTo' - 'sourceEvidenceKeyVersion' - 'sourceEvidenceKeys'`);
    const values = fixture.values.map(row => [...row]);
    values[3]![7] = net;
    edit?.(values);
    const csv = sheetValuesToCsv(values);
    const sync = (source = csv) => runSheetSync(pool, { trigger: "manual", userId: null,
      config: DEFAULT_SYNC_CONFIG, fetcher: async () => source });
    expect(await sync()).toMatchObject({ status: "success", added: 0, changed: 1 });
    const review = (await pool.query<{ id: string; transaction_id: string; employee_id: string }>(`
      SELECT c.id, p.id AS transaction_id, p.employee_id FROM sheet_sync_conflicts c
      JOIN payroll_transactions p ON p.id = c.payroll_transaction_id WHERE c.status = 'open'`)).rows[0]!;
    const action = (input: Partial<SourceNetRecoveryInput> = {}, source = csv, targetPool = pool) =>
      recoverSourceNet(targetPool, review.id, {
        action: "accept", reason: "Confirmed literal numeric NET in original source; parser repair only",
        operationKey: randomUUID(), ...input,
      }, null, { fetcher: async () => source });
    return { pool, review, action, sync, csv, values };
  }

  async function controls(pool = testPool()) {
    return (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(t) - 'total_net_pay' ORDER BY id) FROM payroll_transactions t) AS transactions_except_net,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM import_rows t) AS original_source,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM employee_payroll_checks t) AS checks,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM settlement_obligations t) AS obligations,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM settlement_events t) AS events,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM settlement_batches t) AS batches`)).rows[0];
  }

  for (const net of ["3172.0300", "0.0000", "3172.0301"]) {
    it(`accepts exact ${net}, keeps every other source/financial/Paid field, and appends an idempotent undo`, async () => {
      const { pool, action, sync, review } = await setup(net);
      const before = await controls();
      const operationKey = randomUUID();
      const accepted = await action({ operationKey });
      if (!accepted.ok) throw new Error(accepted.message);
      expect(accepted).toMatchObject({ ok: true, data: { net, alreadyApplied: false } });
      expect(await controls()).toEqual(before);
      expect(await action({ operationKey })).toEqual({ ok: true, data: { ...accepted.data, alreadyApplied: true } });
      expect(await action({ operationKey, reason: "Changed request must not reuse a key" })).toMatchObject({ ok: false, code: "conflict" });
      expect(await sync()).toMatchObject({ status: "no_changes", added: 0, changed: 0 });
      const undo = { action: "undo" as const, acceptanceAuditId: accepted.data.acceptanceAuditId,
        operationKey: randomUUID(), reason: "Reverse the source projection for review" };
      const reversed = await action(undo);
      expect(reversed).toMatchObject({ ok: true, data: { net: null, acceptanceAuditId: accepted.data.acceptanceAuditId } });
      expect(await controls()).toEqual(before);
      expect(await action(undo)).toMatchObject({ ok: true, data: { alreadyApplied: true, net: null } });
      const history = await listSourceNetRecoveryHistory(pool);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ acceptanceAuditId: accepted.data.acceptanceAuditId, conflictId: review.id,
        acceptedNet: net, reversedAt: expect.any(String), reversalAuditId: expect.any(String) });
      const audits = (await pool.query(`SELECT action, metadata FROM audit_logs
        WHERE action IN ('source_net_recovery_accepted', 'source_net_recovery_reversed') ORDER BY created_at`)).rows;
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({ action: "source_net_recovery_accepted", metadata: {
        previous: { totalNetPay: null }, next: { totalNetPay: net }, originalSourceHash: expect.any(String),
        sourceHash: expect.any(String), sourceRowNumbers: [4], originalImportRowId: expect.any(String),
      } });
      expect(audits[1]).toMatchObject({ action: "source_net_recovery_reversed", metadata: {
        acceptanceAuditId: accepted.data.acceptanceAuditId, previous: { totalNetPay: net }, next: { totalNetPay: null },
      } });
      const second = await action();
      expect(second).toMatchObject({ ok: true });
      expect(await action({ ...undo, operationKey: randomUUID() })).toMatchObject({ ok: false, code: "conflict" });
      // An old successful retry is acknowledged without undoing a newer acceptance.
      expect(await action(undo)).toMatchObject({ ok: true, data: { alreadyApplied: true } });
      expect((await pool.query("SELECT total_net_pay FROM payroll_transactions WHERE id = $1", [review.transaction_id])).rows[0])
        .toEqual({ total_net_pay: net });
    }, 40_000);
  }

  it("serializes simultaneous retries and rejects a second independent acceptance without another audit", async () => {
    const { pool, action } = await setup();
    const operationKey = randomUUID();
    const results = await Promise.all([action({ operationKey }), action({ operationKey })]);
    results.push(await action());
    expect(results.filter(result => result.ok && !result.data.alreadyApplied)).toHaveLength(1);
    expect(results.filter(result => result.ok && result.data.alreadyApplied)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE action = 'source_net_recovery_accepted'")).rows[0]?.count).toBe(1);
  }, 40_000);

  it("rejects changed source, routing drift, unsupported scale, and originally blank NET without partial writes", async () => {
    const { pool, action, values, review } = await setup();
    const before = await controls();
    for (const [column, value] of [[7, "3172.04"], [0, "Another payee"], [15, "1"], [7, "3172.03001"]] as const) {
      const changed = values.map(row => [...row]); changed[3]![column] = value;
      expect(await action({}, sheetValuesToCsv(changed))).toMatchObject({ ok: false, code: "conflict" });
    }
    expect(await action({}, "malformed source")).toMatchObject({ ok: false, code: "conflict" });
    expect(await controls()).toEqual(before);
    await pool.query(`UPDATE import_rows SET raw_values = jsonb_set(raw_values, '{raw,totalNetPay}', '""')
      WHERE id = (SELECT import_row_id FROM payroll_transactions WHERE id = $1)`, [review.transaction_id]);
    expect(await action()).toMatchObject({ ok: false, code: "immutable" });
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE action LIKE 'source_net_recovery_%'")).rows[0]?.count).toBe(0);
  }, 40_000);

  it("rejects full-current source scale/routing/non-NET mismatches even after sync updates its snapshot", async () => {
    for (const [column, value] of [[7, "3172.03001"], [0, "Another payee"], [15, "1"]] as const) {
      const { action, pool } = await setup(value === "3172.03001" ? value : undefined, values => { values[3]![column] = value; });
      const before = await controls();
      expect(await action()).toMatchObject({ ok: false });
      expect(await controls()).toEqual(before);
      // Each independent source fixture requires an isolated reset.
      await resetSchema();
      expect((await pool.query("SELECT count(*)::int AS count FROM payroll_transactions")).rows[0]?.count).toBe(0);
    }
  }, 90_000);

  it("rolls back canonical NET, review state, and audit together on a late persistence failure", async () => {
    const { pool, action, csv, review } = await setup();
    const before = await controls();
    const failing: PgLikePool = { query: (sql, params) => pool.query(sql, params), connect: async () => {
      const client = await pool.connect();
      return { query: (sql, params) => {
        if (sql.includes("INSERT INTO audit_logs")) throw new Error("Injected audit write failure");
        return client.query(sql, params);
      }, release: error => client.release(error) };
    } };
    await expect(action({}, csv, failing)).rejects.toThrow("Injected audit write failure");
    expect(await controls()).toEqual(before);
    expect((await pool.query("SELECT status FROM sheet_sync_conflicts WHERE id = $1", [review.id])).rows[0]?.status).toBe("open");
    expect((await pool.query("SELECT total_net_pay FROM payroll_transactions WHERE id = $1", [review.transaction_id])).rows[0]?.total_net_pay).toBeNull();
  }, 40_000);

  async function check(verification: "verified" | "unverified", transactionId: string) {
    return (await testPool().query<{ id: string }>(`INSERT INTO employee_payroll_checks
      (employee_id, check_number, check_date, period_begin, period_end, actual_net, actual_gross, verification_status)
      SELECT employee_id, check_number, check_date, period_begin, period_end, 3172.03, 3800, $2
      FROM payroll_transactions WHERE id = $1 RETURNING id`, [transactionId, verification])).rows[0]!.id;
  }

  it("rejects verified matching checks even without transaction links, and rejects verification after acceptance before undo", async () => {
    const { pool, action, review } = await setup();
    const checkId = await check("unverified", review.transaction_id);
    const before = await controls();
    const accepted = await action();
    expect(accepted).toMatchObject({ ok: true });
    expect(await controls()).toEqual(before);
    if (!accepted.ok) throw new Error(accepted.message);
    await pool.query("UPDATE employee_payroll_checks SET verification_status = 'verified' WHERE id = $1", [checkId]);
    const verified = await controls();
    expect(await action({ action: "undo", acceptanceAuditId: accepted.data.acceptanceAuditId })).toMatchObject({ ok: false, code: "immutable" });
    expect(await controls()).toEqual(verified);
  }, 40_000);

  for (const partial of ["period_begin = NULL, period_end = NULL", "check_number = NULL, check_date = NULL"]) {
    it(`holds a detached verified check with compatible partial identity (${partial})`, async () => {
      const { pool, action, review } = await setup();
      const id = await check("verified", review.transaction_id);
      await pool.query(`UPDATE employee_payroll_checks SET ${partial} WHERE id = $1`, [id]);
      const before = await controls();
      expect(await action()).toMatchObject({ ok: false, code: "immutable" });
      expect(await controls()).toEqual(before);
    }, 40_000);
  }

  it("holds a same-number/date sibling with partial period coordinates and conflicting canonical NET", async () => {
    const { pool, action, review } = await setup();
    await pool.query(`UPDATE payroll_transactions SET check_number = 'NUMERIC-SOURCE-1',
      period_begin = NULL, period_end = NULL, total_net_pay = 1 WHERE id <> $1`, [review.transaction_id]);
    const before = await controls();
    expect(await action()).toMatchObject({ ok: false, code: "immutable" });
    expect(await controls()).toEqual(before);
  }, 40_000);

  it("holds conflicting current source NET on a compatible partial-period sibling whose canonical NET is still unknown", async () => {
    const { pool, action, review, values } = await setup();
    // Attach the existing second source row to this numbered check while
    // retaining its unknown canonical NET. No source money is overwritten.
    await pool.query(`UPDATE payroll_transactions SET check_number = 'NUMERIC-SOURCE-1',
      period_begin = NULL, period_end = NULL WHERE id <> $1`, [review.transaction_id]);
    values[4]![2] = 'NUMERIC-SOURCE-1'; values[4]![8] = ''; values[4]![9] = '';
    values[4]![7] = '1';
    const csv = sheetValuesToCsv(values);
    // Reproduce a current reviewed snapshot with preserved NULL canonical NET
    // on both siblings; only the fresh source evidence knows the disagreement.
    await pool.query(`UPDATE sheet_sync_runs SET snapshot_sha256 = $2
      WHERE id = (SELECT run_id FROM sheet_sync_conflicts WHERE id = $1)`, [review.id, parseSheetCsv(csv).snapshotSha256]);
    expect((await pool.query("SELECT count(*)::int AS count FROM payroll_transactions WHERE total_net_pay IS NULL")).rows[0]?.count).toBe(2);
    const before = await controls();
    expect(await action({}, csv)).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("source check group") });
    expect(await controls()).toEqual(before);
    expect((await pool.query("SELECT total_net_pay FROM payroll_transactions WHERE id = $1", [review.transaction_id])).rows[0]?.total_net_pay).toBeNull();
  }, 40_000);

  for (const provenance of ["nonexistent_transaction", "nonexistent_check", "foreign_transaction"] as const) {
    it(`holds posted legacy history with unusable ${provenance} provenance`, async () => {
      const { pool, action, review } = await setup();
      let sourceId: string = randomUUID();
      if (provenance === "foreign_transaction") {
        const employee = (await pool.query<{ id: string }>(`INSERT INTO employees (display_name, normalized_name)
          VALUES ('Synthetic Foreign Employee', 'synthetic foreign employee') RETURNING id`)).rows[0]!.id;
        sourceId = (await pool.query<{ id: string }>("SELECT id FROM payroll_transactions WHERE id <> $1", [review.transaction_id])).rows[0]!.id;
        await pool.query("UPDATE payroll_transactions SET employee_id = $2 WHERE id = $1", [sourceId, employee]);
      }
      const metadata = provenance === "nonexistent_check" ? { payrollCheckId: sourceId } : { sourceTransactionIds: [sourceId] };
      const obligation = (await pool.query<{ id: string }>(`INSERT INTO settlement_obligations
        (source_key, kind, direction, employee_id, original_amount, calculation_metadata)
        VALUES ('synthetic-unknown-provenance', 'employee_direct', 'receivable', $1, 100, $2) RETURNING id`,
      [review.employee_id, JSON.stringify(metadata)])).rows[0]!.id;
      await pool.query(`INSERT INTO settlement_events (settlement_obligation_id, employee_id, event_type, amount, occurred_on)
        VALUES ($1, $2, 'payment', 1, '2026-08-25')`, [obligation, review.employee_id]);
      const before = await controls();
      expect(await action()).toMatchObject({ ok: false, code: "immutable" });
      expect(await controls()).toEqual(before);
    }, 40_000);
  }

  it("rejects any historical posted event on a correction descendant linked by source metadata", async () => {
    const { pool, action, review } = await setup();
    const root = (await pool.query<{ id: string }>(`INSERT INTO settlement_obligations
      (source_key, kind, direction, employee_id, original_amount, calculation_metadata)
      VALUES ('synthetic-source-root', 'employee_direct', 'receivable', $1, 100, $2) RETURNING id`,
    [review.employee_id, JSON.stringify({ sourceTransactionIds: [review.transaction_id] })])).rows[0]!.id;
    const child = (await pool.query<{ id: string }>(`INSERT INTO settlement_obligations
      (source_key, kind, direction, employee_id, original_amount, calculation_metadata)
      VALUES ('synthetic-source-child', 'employee_direct_correction', 'receivable', $1, 10, $2) RETURNING id`,
    [review.employee_id, JSON.stringify({ adjustmentForObligationId: root })])).rows[0]!.id;
    await pool.query(`INSERT INTO settlement_events (settlement_obligation_id, employee_id, event_type, amount, occurred_on)
      VALUES ($1, $2, 'payment', 1, '2026-08-25')`, [child, review.employee_id]);
    const before = await controls();
    expect(await action()).toMatchObject({ ok: false, code: "immutable" });
    expect(await controls()).toEqual(before);
  }, 40_000);

  it("rejects Undo after source drift without changing the accepted projection or its audit", async () => {
    const { action, values, pool } = await setup();
    const accepted = await action();
    if (!accepted.ok) throw new Error(accepted.message);
    values[3]![7] = "3173.03";
    const before = await controls();
    expect(await action({ action: "undo", acceptanceAuditId: accepted.data.acceptanceAuditId }, sheetValuesToCsv(values)))
      .toMatchObject({ ok: false, code: "conflict" });
    expect(await controls()).toEqual(before);
    expect(await listSourceNetRecoveryHistory(pool)).toMatchObject([{ reversalAuditId: null }]);
  }, 40_000);
});
