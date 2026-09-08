import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import type { SheetSyncConfig } from "@/lib/sheets/config";
import { runSheetSync } from "@/lib/sheets/sync";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
let pool: PgLikePool;
const config: SheetSyncConfig = {
  enabled: true, sheetId: "SYNTHETIC_RETRY_SOURCE", sheetName: "Ahivim",
  scheduleHourUtc: 8, minIntervalMinutes: 60,
};

function transaction(checkNumber: string, date: string): string[] {
  const row = new Array<string>(20).fill("");
  row[0] = "Excellent Staffing";
  row[1] = date;
  row[2] = checkNumber;
  row[4] = "3";
  row[5] = "25";
  row[6] = "75";
  row[8] = date;
  row[9] = date;
  row[10] = "Com Hab";
  row[11] = "Synthetic Retry Individual";
  row[12] = "Synthetic Retry Worker";
  return row;
}

function source(rows: string[][]): string {
  const header = new Array<string>(20).fill("");
  header[0] = "Pay to";
  header[3] = "Code";
  header[10] = "Paid CC2 Description";
  header[11] = "Paid CC3 Description";
  header[12] = "Employee Memo";
  return [new Array<string>(20).fill(""), header, ...rows]
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

function matchingOutage(): PgLikePool {
  return {
    connect: () => pool.connect(),
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      if (sql.includes("SELECT s.id, s.program_id") && sql.includes("FROM scheduled_sessions s")) {
        return Promise.reject(new Error("synthetic matching outage"));
      }
      return pool.query<T>(sql, params);
    },
  };
}

function sync(csv: string, target: PgLikePool = pool) {
  return runSheetSync(target, { trigger: "manual", userId: null, config, fetcher: async () => csv });
}

async function preparePendingMatch(): Promise<{ rows: string[][]; sessionId: string }> {
  const baseline = transaction("RETRY-BASE", "05/10/2023");
  expect((await sync(source([baseline]))).status).toBe("success");
  const { rows: facts } = await pool.query<{
    individual_id: string; employee_id: string; program_id: string;
  }>("SELECT individual_id, employee_id, program_id FROM payroll_transactions LIMIT 1");
  const fact = facts[0]!;
  const { rows: sessions } = await pool.query<{ id: string }>(
    `INSERT INTO scheduled_sessions
       (employee_id, program_id, session_date, duration_hours, is_group, group_size, status)
     VALUES ($1, $2, '2023-06-10', '3', false, 1, 'pending') RETURNING id`,
    [fact.employee_id, fact.program_id],
  );
  const sessionId = sessions[0]!.id;
  await pool.query(
    `INSERT INTO scheduled_allocations (scheduled_session_id, individual_id, allocation_hours)
     VALUES ($1, $2, '3')`, [sessionId, fact.individual_id],
  );
  const rows = [baseline, transaction("RETRY-JUNE", "06/10/2023")];
  const imported = await sync(source(rows), matchingOutage());
  expect(imported).toMatchObject({ status: "success", added: 1 });
  expect(imported.reconciliation?.scheduleMatching).toMatchObject({
    status: "needs_review", from: "2023-06-10", to: "2023-06-10",
  });
  return { rows, sessionId };
}

async function expectMatched(sessionId: string, expectedCount: string) {
  const { rows: sessions } = await pool.query<{ matched_transaction_id: string | null }>(
    "SELECT matched_transaction_id FROM scheduled_sessions WHERE id = $1", [sessionId],
  );
  expect(sessions[0]!.matched_transaction_id).toEqual(expect.any(String));
  const { rows: counts } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM payroll_transactions");
  expect(counts[0]!.count).toBe(expectedCount);
}

suite("Sheet retry and malformed snapshot integrity (PostgreSQL)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(async () => {
    await pool.query(`TRUNCATE sheet_sync_conflicts, sheet_sync_rows, sheet_sync_runs,
      scheduled_allocations, scheduled_sessions, service_allocations, service_sessions,
      rate_exceptions, payroll_transactions, import_warnings, import_rows, import_batches,
      imported_files, individual_aliases, employee_aliases, individuals, employees, audit_logs
      RESTART IDENTITY CASCADE`);
  });
  afterAll(closeTestPool);

  it("retries old matching dates when the next snapshot adds a later transaction", async () => {
    const { rows, sessionId } = await preparePendingMatch();
    rows.push(transaction("RETRY-JULY", "07/10/2023"));
    const retried = await sync(source(rows));
    expect(retried).toMatchObject({ status: "success", added: 1 });
    expect(retried.reconciliation?.scheduleMatching).toMatchObject({
      status: "checked", from: "2023-06-10", to: "2023-07-10", matched: 1,
    });
    await expectMatched(sessionId, "3");
  });

  it("retries old matching dates when only inbound Paid evidence changed", async () => {
    const { rows, sessionId } = await preparePendingMatch();
    rows[0]![13] = "Paid";
    const retried = await sync(source(rows));
    expect(retried).toMatchObject({ status: "success", added: 0 });
    expect(retried.reconciliation?.scheduleMatching).toMatchObject({
      status: "checked", from: "2023-06-10", to: "2023-06-10", matched: 1,
    });
    await expectMatched(sessionId, "2");
    const { rows: paid } = await pool.query<{ is_paid: boolean }>("SELECT is_paid FROM payroll_transactions");
    expect(paid.every((row) => row.is_paid === false)).toBe(true);
  });

  it("retains the combined retry dates after another outage and recovers on an unchanged snapshot", async () => {
    const { rows, sessionId } = await preparePendingMatch();
    rows.push(transaction("RETRY-JULY", "07/10/2023"));
    const csv = source(rows);
    const failedMatching = await sync(csv, matchingOutage());
    expect(failedMatching).toMatchObject({ status: "success", added: 1 });
    expect(failedMatching.reconciliation?.scheduleMatching).toMatchObject({
      status: "needs_review", from: "2023-06-10", to: "2023-07-10",
    });
    const retried = await sync(csv);
    expect(retried.status).toBe("no_changes");
    expect(retried.reconciliation?.scheduleMatching).toMatchObject({
      status: "checked", from: "2023-06-10", to: "2023-07-10", matched: 1,
    });
    await expectMatched(sessionId, "3");
  });

  it.each(["malformed", "transport"])("retains matching retry dates through an intervening %s failure", async (failure) => {
    const { rows, sessionId } = await preparePendingMatch();
    const csv = source(rows);
    const failed = failure === "malformed"
      ? await sync(csv.slice(0, -1))
      : await runSheetSync(pool, { trigger: "manual", userId: null, config,
          fetcher: async () => { throw new Error("synthetic source transport outage"); } });
    expect(failed.status).toBe("failed");
    const retried = await sync(csv);
    expect(retried).toMatchObject({ status: "success", added: 0 });
    expect(retried.reconciliation?.scheduleMatching).toMatchObject({
      status: "checked", from: "2023-06-10", to: "2023-06-10", matched: 1,
    });
    await expectMatched(sessionId, "2");
  });

  it("fails a truncated source before changing transaction or conflict evidence", async () => {
    const csv = source([
      transaction("TRUNCATED-A", "06/10/2023"), transaction("TRUNCATED-B", "07/10/2023"),
    ]);
    expect((await sync(csv)).added).toBe(2);
    const result = await sync(csv.slice(0, -1));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("unterminated quoted field");
    const { rows: controls } = await pool.query<{ transactions: string; conflicts: string; batches: string }>(
      `SELECT (SELECT count(*) FROM payroll_transactions)::text AS transactions,
              (SELECT count(*) FROM sheet_sync_conflicts)::text AS conflicts,
              (SELECT count(*) FROM import_batches)::text AS batches`,
    );
    expect(controls[0]).toEqual({ transactions: "2", conflicts: "0", batches: "1" });
    expect((await sync(csv)).added).toBe(0);
  });
});
