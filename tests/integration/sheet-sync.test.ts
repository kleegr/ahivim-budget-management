import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testPool, resetSchema, closeTestPool } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { runSheetSync } from "@/lib/sheets/sync";
import { applyChangedConflict, dismissConflict } from "@/lib/sheets/resolve";
import type { SheetSyncConfig } from "@/lib/sheets/config";
import type { CsvFetcher } from "@/lib/sheets/fetch";

const suite = hasTestDatabase ? describe : describe.skip;
let pool: PgLikePool;

const CONFIG: SheetSyncConfig = {
  enabled: true,
  sheetId: "TEST_SHEET",
  sheetName: "Ahivim",
  scheduleHourUtc: 8,
  minIntervalMinutes: 60,
};

const okFetcher = (csv: string): CsvFetcher => async () => csv;
const failFetcher: CsvFetcher = async () => {
  throw new Error("temporary sheet outage");
};

/* -------------------------------------------------------------------------- */
/* Synthetic sheet builders (mirror the live tab: totals row, sparse header)  */
/* -------------------------------------------------------------------------- */

interface Row {
  checkNumber: string;
  hours: string;
  rate: string;
  amount: string;
  program: string;
  individual: string;
  employee: string;
  checkDate?: string;
  periodBegin?: string;
  periodEnd?: string;
}

const R1: Row = { checkNumber: "1001", hours: "10", rate: "25", amount: "250", program: "Com Hab", individual: "Aaron Tester", employee: "Zed Worker" };
const R2: Row = { checkNumber: "1002", hours: "5", rate: "19", amount: "95", program: "Respite", individual: "Bella Sample", employee: "Yan Staff" };
const R3: Row = { checkNumber: "1003", hours: "8", rate: "25", amount: "200", program: "Com Hab", individual: "Cara Person", employee: "Xen Aide" };
const R4: Row = { checkNumber: "1004", hours: "4", rate: "25", amount: "100", program: "Com Hab", individual: "Dov Fourth", employee: "Wim Helper" };

function toCsv(grid: string[][]): string {
  return grid.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
}

function buildSheet(rows: Row[]): string {
  const gross = rows.reduce((s, r) => s + Number(r.amount), 0).toFixed(2);
  const totals = new Array(20).fill("");
  totals[16] = gross; // Q: agency gross (the one total we can assert exactly)

  const header = new Array(20).fill("");
  header[0] = "Pay to";
  header[3] = "Code";
  header[10] = "Paid CC2 Description";
  header[11] = "Paid CC3 Description";
  header[12] = "Employee Memo";

  const dataRows = rows.map((r) => {
    const a = new Array(20).fill("");
    a[0] = "Excellent Staffing";
    a[1] = r.checkDate ?? "05/25/2023";
    a[2] = r.checkNumber;
    a[4] = r.hours;
    a[5] = r.rate;
    a[6] = r.amount;
    a[8] = r.periodBegin ?? "05/01/2023";
    a[9] = r.periodEnd ?? "05/15/2023";
    a[10] = r.program;
    a[11] = r.individual;
    a[12] = r.employee;
    return a;
  });

  return toCsv([totals, header, ...dataRows]);
}

async function count(table: string): Promise<number> {
  const { rows } = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM ${table}`);
  return Number(rows[0]!.c);
}

async function sumAmount(): Promise<number> {
  const { rows } = await pool.query<{ s: string | null }>(
    `SELECT COALESCE(sum(imported_amount),0)::text s FROM payroll_transactions`,
  );
  return Number(rows[0]!.s ?? 0);
}

suite("Google Sheet sync (real PostgreSQL)", () => {
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

  it("first sync imports every row and reconciles the agency gross total", async () => {
    const res = await runSheetSync(pool, {
      trigger: "initial",
      userId: null,
      fetcher: okFetcher(buildSheet([R1, R2, R3])),
      config: CONFIG,
    });

    expect(res.status).toBe("success");
    expect(res.added).toBe(3);
    expect(res.skipped).toBe(0);
    expect(res.changed).toBe(0);
    expect(res.missing).toBe(0);
    expect(await count("payroll_transactions")).toBe(3);
    expect(await sumAmount()).toBeCloseTo(545, 2);
    // The workbook agency gross total was supplied and matches the imported sum.
    expect(res.reconciliation?.agencyGrossMatches).toBe(true);
    // Every synced row is tracked back to a transaction.
    expect(await count("sheet_sync_rows")).toBe(3);
  });

  it("re-syncing an unchanged sheet is a no-op and never duplicates", async () => {
    const csv = buildSheet([R1, R2, R3]);
    await runSheetSync(pool, { trigger: "manual", userId: null, fetcher: okFetcher(csv), config: CONFIG });
    const again = await runSheetSync(pool, { trigger: "scheduled", userId: null, fetcher: okFetcher(csv), config: CONFIG });

    expect(again.status).toBe("no_changes");
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(3);
    expect(await count("payroll_transactions")).toBe(3);
  });

  it("imports only the genuinely new row on the next sync (no duplicates)", async () => {
    await runSheetSync(pool, { trigger: "manual", userId: null, fetcher: okFetcher(buildSheet([R1, R2, R3])), config: CONFIG });
    const res = await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: okFetcher(buildSheet([R1, R2, R3, R4])),
      config: CONFIG,
    });

    expect(res.status).toBe("success");
    expect(res.added).toBe(1);
    expect(res.skipped).toBe(3);
    expect(await count("payroll_transactions")).toBe(4);
  });

  it("connects only an exact daily record and leaves aggregates or mismatches for review", async () => {
    await runSheetSync(pool, {
      trigger: "manual",
      userId: null,
      fetcher: okFetcher(buildSheet([R1, R2, R3])),
      config: CONFIG,
    });
    const { rows: facts } = await pool.query<{
      individual_id: string;
      employee_id: string;
      program_id: string;
    }>(
      `SELECT individual_id, employee_id, program_id
         FROM payroll_transactions
        WHERE check_number = '1001'`,
    );
    const fact = facts[0]!;
    const { rows: otherEmployees } = await pool.query<{ id: string }>(
      `SELECT id FROM employees WHERE display_name = 'Yan Staff'`,
    );
    const sessionIds: string[] = [];
    async function addPlannedVisit(date: string, hours: string, employeeId = fact.employee_id) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO scheduled_sessions
           (employee_id, program_id, session_date, duration_hours, is_group, group_size, status)
         VALUES ($1, $2, $3, $4, false, 1, 'pending')
         RETURNING id`,
        [employeeId, fact.program_id, date, hours],
      );
      await pool.query(
        `INSERT INTO scheduled_allocations (scheduled_session_id, individual_id, allocation_hours)
         VALUES ($1, $2, $3)`,
        [rows[0]!.id, fact.individual_id, hours],
      );
      sessionIds.push(rows[0]!.id);
    }
    await addPlannedVisit("2023-06-10", "3");
    await addPlannedVisit("2023-07-10", "3");
    await addPlannedVisit("2023-08-10", "3");
    await addPlannedVisit("2023-09-10", "3", otherEmployees[0]!.id);

    const exactDaily = {
      ...R1,
      checkNumber: "1005",
      hours: "3",
      amount: "75",
      checkDate: "06/10/2023",
      periodBegin: "06/10/2023",
      periodEnd: "06/10/2023",
    };
    const aggregate = {
      ...R1,
      checkNumber: "1006",
      hours: "3",
      amount: "75",
      checkDate: "07/25/2023",
      periodBegin: "07/01/2023",
      periodEnd: "07/15/2023",
    };
    const hoursMismatch = {
      ...R1,
      checkNumber: "1007",
      hours: "4",
      amount: "100",
      checkDate: "08/10/2023",
      periodBegin: "08/10/2023",
      periodEnd: "08/10/2023",
    };
    const employeeMismatch = {
      ...R1,
      checkNumber: "1008",
      hours: "3",
      amount: "75",
      checkDate: "09/10/2023",
      periodBegin: "09/10/2023",
      periodEnd: "09/10/2023",
    };

    const result = await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: okFetcher(buildSheet([
        R1,
        R2,
        R3,
        exactDaily,
        aggregate,
        hoursMismatch,
        employeeMismatch,
      ])),
      config: CONFIG,
    });

    expect(result.status).toBe("success");
    expect(result.note).toContain("4 eligible planned visits; 1 exact daily record was connected");
    const { rows: matches } = await pool.query<{ id: string; matched_transaction_id: string | null }>(
      `SELECT id, matched_transaction_id
         FROM scheduled_sessions
        WHERE id = ANY($1::uuid[])
        ORDER BY session_date`,
      [sessionIds],
    );
    expect(matches.map((row) => row.matched_transaction_id !== null)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("keeps a committed import successful when matching fails and retries on an unchanged sync", async () => {
    await runSheetSync(pool, {
      trigger: "manual",
      userId: null,
      fetcher: okFetcher(buildSheet([R1, R2, R3])),
      config: CONFIG,
    });
    const { rows: facts } = await pool.query<{
      individual_id: string;
      employee_id: string;
      program_id: string;
    }>(
      `SELECT individual_id, employee_id, program_id
         FROM payroll_transactions
        WHERE check_number = '1001'`,
    );
    const fact = facts[0]!;
    const { rows: sessions } = await pool.query<{ id: string }>(
      `INSERT INTO scheduled_sessions
         (employee_id, program_id, session_date, duration_hours, is_group, group_size, status)
       VALUES ($1, $2, '2023-06-10', '3', false, 1, 'pending')
       RETURNING id`,
      [fact.employee_id, fact.program_id],
    );
    await pool.query(
      `INSERT INTO scheduled_allocations (scheduled_session_id, individual_id, allocation_hours)
       VALUES ($1, $2, '3')`,
      [sessions[0]!.id, fact.individual_id],
    );
    const exactDaily = {
      ...R1,
      checkNumber: "1005",
      hours: "3",
      amount: "75",
      checkDate: "06/10/2023",
      periodBegin: "06/10/2023",
      periodEnd: "06/10/2023",
    };
    const csv = buildSheet([R1, R2, R3, exactDaily]);
    const matchingFailurePool: PgLikePool = {
      query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
        if (sql.includes("SELECT s.id, s.program_id") && sql.includes("FROM scheduled_sessions s")) {
          return Promise.reject(new Error("temporary schedule matching outage"));
        }
        return pool.query<T>(sql, params);
      },
      connect: () => pool.connect(),
    };

    const imported = await runSheetSync(matchingFailurePool, {
      trigger: "scheduled",
      userId: null,
      fetcher: okFetcher(csv),
      config: CONFIG,
    });

    expect(imported.status).toBe("success");
    expect(imported.added).toBe(1);
    expect(imported.note).toContain("Transactions were imported successfully");
    expect(await count("payroll_transactions")).toBe(4);
    const { rows: importedRuns } = await pool.query<{
      status: string;
      reconciliation: { scheduleMatching?: { status?: string; from?: string; to?: string } };
    }>(`SELECT status, reconciliation FROM sheet_sync_runs WHERE id = $1`, [imported.runId]);
    expect(importedRuns[0]!.status).toBe("success");
    expect(importedRuns[0]!.reconciliation.scheduleMatching).toMatchObject({
      status: "needs_review",
      from: "2023-06-10",
      to: "2023-06-10",
    });

    const retry = await runSheetSync(pool, {
      trigger: "manual",
      userId: null,
      fetcher: okFetcher(csv),
      config: CONFIG,
    });

    expect(retry.status).toBe("no_changes");
    expect(retry.note).toContain("Schedule matching checked 1 eligible planned visit; 1 exact daily record was connected");
    expect(await count("payroll_transactions")).toBe(4);
    expect(await pool.query<{ matched_transaction_id: string | null }>(
      `SELECT matched_transaction_id FROM scheduled_sessions WHERE id = $1`,
      [sessions[0]!.id],
    )).toMatchObject({ rows: [{ matched_transaction_id: expect.any(String) }] });
    const { rows: retriedRuns } = await pool.query<{
      reconciliation: { scheduleMatching?: { status?: string } };
    }>(`SELECT reconciliation FROM sheet_sync_runs WHERE id = $1`, [retry.runId]);
    expect(retriedRuns[0]!.reconciliation.scheduleMatching?.status).toBe("checked");
  });

  it("flags a changed row for review instead of duplicating or overwriting it", async () => {
    await runSheetSync(pool, { trigger: "manual", userId: null, fetcher: okFetcher(buildSheet([R1, R2, R3])), config: CONFIG });

    // Same identity (check/individual/employee/program/period) but a different amount.
    const changed = { ...R2, amount: "120" };
    const res = await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: okFetcher(buildSheet([R1, changed, R3])),
      config: CONFIG,
    });

    expect(res.changed).toBe(1);
    expect(res.added).toBe(0);
    expect(res.flagged).toBeGreaterThanOrEqual(1);
    // No new transaction; the original figure is untouched.
    expect(await count("payroll_transactions")).toBe(3);
    expect(await sumAmount()).toBeCloseTo(545, 2);

    const { rows: conflicts } = await pool.query<{ type: string; audited: boolean; status: string }>(
      `SELECT type, audited, status FROM sheet_sync_conflicts WHERE type = 'changed'`,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.audited).toBe(false);
    expect(conflicts[0]!.status).toBe("open");

    const { rows: flagged } = await pool.query<{ c: string }>(
      `SELECT count(*)::text c FROM payroll_transactions WHERE sync_review_reason = 'source_changed'`,
    );
    expect(Number(flagged[0]!.c)).toBe(1);
  });

  it("never overwrites an audited manual correction; it flags the conflict as audited", async () => {
    await runSheetSync(pool, { trigger: "manual", userId: null, fetcher: okFetcher(buildSheet([R1, R2, R3])), config: CONFIG });

    // Mark R2's transaction as carrying an audited manual correction.
    await pool.query(
      `UPDATE import_rows SET correction_status = 'corrected', corrected_values = '{"amount":"95"}'::jsonb
        WHERE id = (SELECT import_row_id FROM payroll_transactions
                     WHERE check_number = '1002' LIMIT 1)`,
    );

    const changed = { ...R2, amount: "120" };
    const res = await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: okFetcher(buildSheet([R1, changed, R3])),
      config: CONFIG,
    });
    expect(res.changed).toBe(1);

    const { rows } = await pool.query<{ audited: boolean }>(
      `SELECT audited FROM sheet_sync_conflicts WHERE type = 'changed'`,
    );
    expect(rows[0]!.audited).toBe(true);
    // The audited figure is unchanged.
    const { rows: amt } = await pool.query<{ a: string }>(
      `SELECT imported_amount::text a FROM payroll_transactions WHERE check_number = '1002'`,
    );
    expect(Number(amt[0]!.a)).toBeCloseTo(95, 2);

    // Applying is refused over an audited correction.
    const conflictId = (await pool.query<{ id: string }>(`SELECT id FROM sheet_sync_conflicts WHERE type='changed'`)).rows[0]!.id;
    const applied = await applyChangedConflict(pool, conflictId, null, {
      fetcher: okFetcher(buildSheet([R1, changed, R3])),
      config: CONFIG,
    });
    expect(applied.ok).toBe(false);
  });

  it("flags a missing source row for review and never deletes the transaction", async () => {
    await runSheetSync(pool, { trigger: "manual", userId: null, fetcher: okFetcher(buildSheet([R1, R2, R3])), config: CONFIG });

    // R2 removed from the sheet.
    const res = await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: okFetcher(buildSheet([R1, R3])),
      config: CONFIG,
    });

    expect(res.missing).toBe(1);
    // The transaction still exists — nothing is auto-deleted.
    expect(await count("payroll_transactions")).toBe(3);
    const { rows } = await pool.query<{ reason: string | null }>(
      `SELECT sync_review_reason AS reason FROM payroll_transactions WHERE check_number = '1002'`,
    );
    expect(rows[0]!.reason).toBe("source_missing");
    const { rows: mc } = await pool.query<{ c: string }>(
      `SELECT count(*)::text c FROM sheet_sync_conflicts WHERE type = 'missing' AND status = 'open'`,
    );
    expect(Number(mc[0]!.c)).toBe(1);
  });

  it("records a temporary fetch failure and recovers on the next successful run", async () => {
    const failed = await runSheetSync(pool, { trigger: "scheduled", userId: null, fetcher: failFetcher, config: CONFIG });
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("temporary sheet outage");
    // Nothing was written.
    expect(await count("payroll_transactions")).toBe(0);
    const { rows: runRow } = await pool.query<{ status: string; error_message: string | null }>(
      `SELECT status, error_message FROM sheet_sync_runs ORDER BY started_at DESC LIMIT 1`,
    );
    expect(runRow[0]!.status).toBe("failed");
    expect(runRow[0]!.error_message).toBeTruthy();

    // Retry succeeds.
    const recovered = await runSheetSync(pool, {
      trigger: "manual",
      userId: null,
      fetcher: okFetcher(buildSheet([R1, R2, R3])),
      config: CONFIG,
    });
    expect(recovered.status).toBe("success");
    expect(recovered.added).toBe(3);
    expect(await count("payroll_transactions")).toBe(3);
  });

  it("applies a changed row in place without creating a competing transaction", async () => {
    await runSheetSync(pool, { trigger: "manual", userId: null, fetcher: okFetcher(buildSheet([R1, R2, R3])), config: CONFIG });

    const changedCsv = buildSheet([R1, { ...R2, amount: "120" }, R3]);
    await runSheetSync(pool, { trigger: "scheduled", userId: null, fetcher: okFetcher(changedCsv), config: CONFIG });

    const conflictId = (await pool.query<{ id: string }>(`SELECT id FROM sheet_sync_conflicts WHERE type='changed' AND status='open'`)).rows[0]!.id;
    const applied = await applyChangedConflict(pool, conflictId, null, { fetcher: okFetcher(changedCsv), config: CONFIG });
    expect(applied.ok).toBe(true);

    // Same number of transactions; the figure is the sheet's new value, not a double.
    expect(await count("payroll_transactions")).toBe(3);
    expect(await sumAmount()).toBeCloseTo(570, 2); // 250 + 120 + 200
    const { rows } = await pool.query<{ a: string; reason: string | null }>(
      `SELECT imported_amount::text a, sync_review_reason AS reason FROM payroll_transactions WHERE check_number = '1002'`,
    );
    expect(Number(rows[0]!.a)).toBeCloseTo(120, 2);
    expect(rows[0]!.reason).toBeNull();
    const { rows: st } = await pool.query<{ status: string }>(`SELECT status FROM sheet_sync_conflicts WHERE id = $1`, [conflictId]);
    expect(st[0]!.status).toBe("applied");
  });

  it("dismissing a missing conflict clears the flag and keeps the transaction", async () => {
    await runSheetSync(pool, { trigger: "manual", userId: null, fetcher: okFetcher(buildSheet([R1, R2, R3])), config: CONFIG });
    await runSheetSync(pool, { trigger: "scheduled", userId: null, fetcher: okFetcher(buildSheet([R1, R3])), config: CONFIG });

    const conflictId = (await pool.query<{ id: string }>(`SELECT id FROM sheet_sync_conflicts WHERE type='missing' AND status='open'`)).rows[0]!.id;
    const res = await dismissConflict(pool, conflictId, null, "kept intentionally");
    expect(res.ok).toBe(true);

    expect(await count("payroll_transactions")).toBe(3);
    const { rows } = await pool.query<{ reason: string | null }>(
      `SELECT sync_review_reason AS reason FROM payroll_transactions WHERE check_number = '1002'`,
    );
    expect(rows[0]!.reason).toBeNull();
  });
});
