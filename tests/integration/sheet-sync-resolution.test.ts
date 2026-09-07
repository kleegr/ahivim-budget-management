import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import type { SheetSyncConfig } from "@/lib/sheets/config";
import type { CsvFetcher } from "@/lib/sheets/fetch";
import { applyChangedConflict, dismissConflict } from "@/lib/sheets/resolve";
import { runSheetSync } from "@/lib/sheets/sync";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
let pool: PgLikePool;

const CONFIG: SheetSyncConfig = {
  enabled: true,
  sheetId: "TEST_SHEET",
  sheetName: "Ahivim",
  scheduleHourUtc: 8,
  minIntervalMinutes: 60,
};

interface Row {
  payTo: string;
  checkNumber: string;
  hours: string;
  rate: string;
  amount: string;
  totalNetPay: string;
  program: string;
  individual: string;
  employee: string;
  paid?: string;
}

const BASE: Row = {
  payTo: "Excellent Staffing",
  checkNumber: "9001",
  hours: "10",
  rate: "25",
  amount: "250",
  totalNetPay: "225",
  program: "Com Hab",
  individual: "Resolver Person",
  employee: "Resolver Worker",
};
const OTHER: Row = {
  payTo: "Excellent Staffing",
  checkNumber: "9002",
  hours: "5",
  rate: "19",
  amount: "95",
  totalNetPay: "85",
  program: "Respite",
  individual: "Other Person",
  employee: "Other Worker",
};

const fetcher = (csv: string): CsvFetcher => async () => csv;

function toCsv(grid: string[][]): string {
  return grid.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
}

function sheet(rows: Row[]): string {
  const totals = new Array(20).fill("");
  totals[16] = rows.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(2);
  const header = new Array(20).fill("");
  header[0] = "Pay to";
  header[3] = "Code";
  header[10] = "Paid CC2 Description";
  header[11] = "Paid CC3 Description";
  header[12] = "Employee Memo";
  const data = rows.map((row) => {
    const cells = new Array(20).fill("");
    cells[0] = row.payTo;
    cells[1] = "05/25/2023";
    cells[2] = row.checkNumber;
    cells[4] = row.hours;
    cells[5] = row.rate;
    cells[6] = row.amount;
    cells[7] = row.totalNetPay;
    cells[8] = "05/01/2023";
    cells[9] = "05/15/2023";
    cells[10] = row.program;
    cells[11] = row.individual;
    cells[12] = row.employee;
    cells[13] = row.paid ?? "";
    return cells;
  });
  return toCsv([totals, header, ...data]);
}

async function initialSync(): Promise<void> {
  await runSheetSync(pool, {
    trigger: "initial",
    userId: null,
    fetcher: fetcher(sheet([BASE, OTHER])),
    config: CONFIG,
  });
}

async function baseTransactionId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM payroll_transactions WHERE check_number = $1`,
    [BASE.checkNumber],
  );
  return rows[0]!.id;
}

suite("Sheet conflict resolution hardening (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE sheet_sync_conflicts, sheet_sync_rows, sheet_sync_runs,
               service_allocations, service_sessions, rate_exceptions,
               payroll_transactions, import_warnings, import_rows, import_batches,
               imported_files, individual_aliases, employee_aliases,
               individuals, employees, audit_logs
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(closeTestPool);

  it("applies canonical values without changing Pay-To or Total Net Pay and refreshes tracking evidence", async () => {
    await initialSync();
    const changed = { ...BASE, amount: "275" };
    const changedSheet = sheet([changed, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(changedSheet),
      config: CONFIG,
    });
    const { rows: conflicts } = await pool.query<{ id: string }>(
      `SELECT id FROM sheet_sync_conflicts
        WHERE payroll_transaction_id = $1 AND type = 'changed' AND status = 'open'
          AND COALESCE(previous->>'sourceEvidenceConflict', '') = ''`,
      [await baseTransactionId()],
    );
    expect(conflicts).toHaveLength(1);

    expect(await applyChangedConflict(pool, conflicts[0]!.id, null, {
      fetcher: fetcher(changedSheet),
      config: CONFIG,
    })).toMatchObject({ ok: true });

    const { rows: transaction } = await pool.query<{
      amount: string; pay_to: string; net: string; reason: string | null;
    }>(
      `SELECT imported_amount::text AS amount, pay_to_raw AS pay_to,
              total_net_pay::text AS net, sync_review_reason AS reason
         FROM payroll_transactions WHERE check_number = $1`,
      [BASE.checkNumber],
    );
    expect(transaction).toEqual([{
      amount: "275.0000",
      pay_to: BASE.payTo,
      net: "225.0000",
      reason: null,
    }]);
    const { rows: tracking } = await pool.query<{
      amount: string; occurrence_count: string; source_rows: number[];
      version: string; evidence_count: number;
    }>(
      `SELECT identity->>'amount' AS amount,
              identity->>'sourceOccurrenceCount' AS occurrence_count,
              identity->'sourceRowNumbers' AS source_rows,
              identity->>'sourceEvidenceKeyVersion' AS version,
              jsonb_array_length(identity->'sourceEvidenceKeys') AS evidence_count
         FROM sheet_sync_rows WHERE payroll_transaction_id = $1`,
      [await baseTransactionId()],
    );
    expect(tracking).toEqual([{
      amount: "275",
      occurrence_count: "1",
      source_rows: [3],
      version: "v2",
      evidence_count: 1,
    }]);

    const followUp = await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      // Paid evidence changes the snapshot and forces a full classifier pass,
      // but can never change the application-owned Neon Paid decision.
      fetcher: fetcher(sheet([{ ...OTHER, paid: "Paid" }, changed])),
      config: CONFIG,
    });
    expect(followUp.changed).toBe(0);
    const { rows: stillOpen } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sheet_sync_conflicts WHERE status = 'open'`,
    );
    expect(stillOpen).toEqual([{ count: "0" }]);
  });

  it("adopts combined routing/net evidence on dismiss while retaining one ordinary canonical conflict", async () => {
    await initialSync();
    const combined = {
      ...BASE,
      amount: "275",
      payTo: "Direct Employee",
      totalNetPay: "230",
    };
    const combinedSheet = sheet([combined, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(combinedSheet),
      config: CONFIG,
    });
    const transactionId = await baseTransactionId();
    const { rows: evidenceConflicts } = await pool.query<{ id: string }>(
      `SELECT id FROM sheet_sync_conflicts
        WHERE payroll_transaction_id = $1 AND status = 'open'
          AND previous->>'sourceEvidenceConflict' = 'routing_or_net'`,
      [transactionId],
    );
    expect(evidenceConflicts).toHaveLength(1);

    expect(await dismissConflict(pool, evidenceConflicts[0]!.id, null, "Accepted source evidence")).toMatchObject({ ok: true });

    const { rows: unchanged } = await pool.query<{ amount: string; pay_to: string; net: string }>(
      `SELECT imported_amount::text AS amount, pay_to_raw AS pay_to, total_net_pay::text AS net
         FROM payroll_transactions WHERE id = $1`,
      [transactionId],
    );
    expect(unchanged).toEqual([{ amount: "250.0000", pay_to: BASE.payTo, net: "225.0000" }]);
    const { rows: adopted } = await pool.query<{
      amount: string; pay_to: string; net: string; evidence_count: number;
    }>(
      `SELECT identity->>'amount' AS amount, identity->>'payTo' AS pay_to,
              identity->>'totalNetPay' AS net,
              jsonb_array_length(identity->'sourceEvidenceKeys') AS evidence_count
         FROM sheet_sync_rows WHERE payroll_transaction_id = $1`,
      [transactionId],
    );
    expect(adopted).toEqual([{ amount: "250", pay_to: combined.payTo, net: "230.0000", evidence_count: 1 }]);
    const { rows: canonicalConflicts } = await pool.query<{ id: string }>(
      `SELECT id FROM sheet_sync_conflicts
        WHERE payroll_transaction_id = $1 AND status = 'open'
          AND COALESCE(previous->>'sourceEvidenceConflict', '') = ''`,
      [transactionId],
    );
    expect(canonicalConflicts).toHaveLength(1);

    expect(await applyChangedConflict(pool, canonicalConflicts[0]!.id, null, {
      fetcher: fetcher(combinedSheet),
      config: CONFIG,
    })).toMatchObject({ ok: true });
    const { rows: applied } = await pool.query<{ amount: string; pay_to: string; net: string }>(
      `SELECT imported_amount::text AS amount, pay_to_raw AS pay_to, total_net_pay::text AS net
         FROM payroll_transactions WHERE id = $1`,
      [transactionId],
    );
    expect(applied).toEqual([{ amount: "275.0000", pay_to: BASE.payTo, net: "225.0000" }]);

    const afterReorder = await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(sheet([{ ...OTHER, paid: "Paid" }, combined])),
      config: CONFIG,
    });
    expect(afterReorder.changed).toBe(0);
    const { rows: reopened } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sheet_sync_conflicts WHERE status = 'open'`,
    );
    expect(reopened).toEqual([{ count: "0" }]);
  });

  it("derives the review flag and tracking state from conflicts still open after each dismiss", async () => {
    await initialSync();
    const transactionId = await baseTransactionId();
    const { rows: trackingRows } = await pool.query<{ id: string; natural_key: string }>(
      `SELECT id, natural_key FROM sheet_sync_rows WHERE payroll_transaction_id = $1`,
      [transactionId],
    );
    const tracking = trackingRows[0]!;
    const { rows: created } = await pool.query<{ id: string; type: string }>(
      `INSERT INTO sheet_sync_conflicts
         (sync_row_id, payroll_transaction_id, type, natural_key, previous, incoming, status)
       VALUES
         ($1,$2,'changed',$3,'{}'::jsonb,'{}'::jsonb,'open'),
         ($1,$2,'missing',$3,'{}'::jsonb,'{}'::jsonb,'open')
       RETURNING id, type`,
      [tracking.id, transactionId, tracking.natural_key],
    );
    await pool.query(
      `UPDATE payroll_transactions SET sync_review_reason = 'source_missing' WHERE id = $1`,
      [transactionId],
    );
    await pool.query(`UPDATE sheet_sync_rows SET state = 'missing' WHERE id = $1`, [tracking.id]);

    const missingId = created.find((row) => row.type === "missing")!.id;
    const changedId = created.find((row) => row.type === "changed")!.id;
    expect(await dismissConflict(pool, missingId, null)).toMatchObject({ ok: true });
    const { rows: changedRemains } = await pool.query<{ reason: string; state: string }>(
      `SELECT t.sync_review_reason AS reason, s.state
         FROM payroll_transactions t JOIN sheet_sync_rows s ON s.payroll_transaction_id = t.id
        WHERE t.id = $1`,
      [transactionId],
    );
    expect(changedRemains).toEqual([{ reason: "source_changed", state: "conflict" }]);

    expect(await dismissConflict(pool, changedId, null)).toMatchObject({ ok: true });
    const { rows: allClosed } = await pool.query<{ reason: string | null; state: string }>(
      `SELECT t.sync_review_reason AS reason, s.state
         FROM payroll_transactions t JOIN sheet_sync_rows s ON s.payroll_transaction_id = t.id
        WHERE t.id = $1`,
      [transactionId],
    );
    expect(allClosed).toEqual([{ reason: null, state: "active" }]);
  });

  it("serializes duplicate dismiss requests so exactly one closes and audits the conflict", async () => {
    await initialSync();
    const transactionId = await baseTransactionId();
    const { rows: trackingRows } = await pool.query<{ id: string; natural_key: string }>(
      `SELECT id, natural_key FROM sheet_sync_rows WHERE payroll_transaction_id = $1`,
      [transactionId],
    );
    const tracking = trackingRows[0]!;
    const { rows: conflicts } = await pool.query<{ id: string }>(
      `INSERT INTO sheet_sync_conflicts
         (sync_row_id, payroll_transaction_id, type, natural_key, previous, incoming, status)
       VALUES ($1,$2,'missing',$3,'{}'::jsonb,'{}'::jsonb,'open')
       RETURNING id`,
      [tracking.id, transactionId, tracking.natural_key],
    );
    const conflictId = conflicts[0]!.id;

    const results = await Promise.all([
      dismissConflict(pool, conflictId, null, "first request"),
      dismissConflict(pool, conflictId, null, "duplicate request"),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const { rows: auditCount } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
        WHERE action = 'sheet_sync_conflict_dismissed' AND entity_id = $1`,
      [conflictId],
    );
    expect(auditCount).toEqual([{ count: "1" }]);
  });
});
