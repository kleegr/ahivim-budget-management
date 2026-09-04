import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { createEmployee } from "@/lib/manage/employees";
import {
  archiveDirectPayTarget,
  saveDirectPayTarget,
  savePayrollCheck,
  syncImportedPayrollCheckReviews,
} from "@/lib/manage/direct-pay-operations";
import {
  closeTestPool,
  hasTestDatabase,
  resetSchema,
  testPool,
  truncateBusinessTables,
} from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
}

suite("direct-pay operations (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);

  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES ($1, 'admin@example.test', 'Admin', 'x', 'admin')`,
      [ACTOR],
    );
  });

  afterAll(closeTestPool);

  it("rejects overlapping active targets in both the service and database", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Gross Target Employee" }, ACTOR));
    const first = unwrap(await saveDirectPayTarget(pool, {
      employeeId: employee.id,
      intervalUnit: "week",
      intervalCount: 1,
      grossTargetAmount: "1000",
      planningHourlyRate: "25",
      effectiveFrom: "2026-08-01",
      effectiveTo: "2026-08-31",
    }, ACTOR));

    const overlap = await saveDirectPayTarget(pool, {
      employeeId: employee.id,
      intervalUnit: "week",
      intervalCount: 1,
      grossTargetAmount: "1200",
      planningHourlyRate: "25",
      effectiveFrom: "2026-08-15",
      effectiveTo: "2026-09-15",
    }, ACTOR);
    expect(overlap).toMatchObject({ ok: false, code: "conflict" });

    await expect(pool.query(
      `INSERT INTO employee_direct_pay_targets
         (employee_id, interval_unit, interval_count, gross_target_amount,
          planning_hourly_rate, effective_from, effective_to)
       VALUES ($1, 'week', 1, 900, 25, '2026-08-20', '2026-09-01')`,
      [employee.id],
    )).rejects.toMatchObject({ code: "23P01" });

    unwrap(await archiveDirectPayTarget(pool, first.id, ACTOR));
    expect((await saveDirectPayTarget(pool, {
      employeeId: employee.id,
      intervalUnit: "week",
      intervalCount: 1,
      grossTargetAmount: "1000",
      planningHourlyRate: "25",
      effectiveFrom: "2026-08-01",
      effectiveTo: "2026-08-31",
    }, ACTOR)).ok).toBe(true);
  });

  it("links checks through catalog routing and preserves links across identity corrections", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Payroll Check Employee" }, ACTOR));
    const program = await pool.query<{ id: string }>(
      `SELECT id FROM programs WHERE payment_recipient = 'employee' ORDER BY code LIMIT 1`,
    );
    expect(program.rows[0]).toBeDefined();
    const agencyProgram = await pool.query<{ id: string }>(
      `SELECT id FROM programs WHERE payment_recipient = 'agency' ORDER BY code LIMIT 1`,
    );
    expect(agencyProgram.rows[0]).toBeDefined();
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, program_id, check_number, check_date, period_begin, period_end,
          imported_hours, imported_amount, payment_recipient, transaction_fingerprint)
       VALUES
         ($1, $2, 'CHECK-10', '2026-08-15', '2026-08-01', '2026-08-14',
          10, 250, NULL, 'direct-pay-check-link'),
         ($1, $2, 'CHECK-10', '2026-08-15', '2026-08-01', '2026-08-14',
          10, 250, 'unknown', 'direct-pay-check-unknown-fallback'),
         ($1, $2, 'CHECK-10', '2026-08-15', '2026-08-01', '2026-08-14',
          10, 250, 'excellent_staffing', 'direct-pay-check-explicit-agency'),
         ($1, $3, 'CHECK-10', '2026-08-15', '2026-08-01', '2026-08-14',
          10, 250, 'employee', 'direct-pay-check-explicit-employee'),
         ($1, $2, 'CHECK-OTHER', '2026-08-15', '2026-08-01', '2026-08-14',
          10, 250, 'employee', 'direct-pay-check-same-period-other-number')`,
      [employee.id, program.rows[0]!.id, agencyProgram.rows[0]!.id],
    );

    const check = unwrap(await savePayrollCheck(pool, {
      employeeId: employee.id,
      checkNumber: "CHECK-10",
      checkDate: "2026-08-15",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-14",
      actualGross: "500",
      actualNet: "420",
      taxWithheld: "80",
    }, ACTOR));
    expect(check.linkedTransactions).toBe(3);

    const corrected = unwrap(await savePayrollCheck(pool, {
      id: check.id,
      employeeId: employee.id,
      checkNumber: "CHECK-10-CORRECTED",
      checkDate: "2026-08-16",
      periodBegin: "2026-08-01",
      periodEnd: "2026-08-14",
      actualGross: "500",
      actualNet: "420",
      taxWithheld: "80",
    }, ACTOR));
    expect(corrected.linkedTransactions).toBe(3);
    const linked = await pool.query<{ payroll_check_id: string | null }>(
      `SELECT payroll_check_id FROM payroll_transactions WHERE transaction_fingerprint = 'direct-pay-check-link'`,
    );
    expect(linked.rows[0]?.payroll_check_id).toBe(check.id);
    const explicitAgency = await pool.query<{ payroll_check_id: string | null }>(
      `SELECT payroll_check_id FROM payroll_transactions
        WHERE transaction_fingerprint = 'direct-pay-check-explicit-agency'`,
    );
    expect(explicitAgency.rows[0]?.payroll_check_id).toBeNull();
    const otherNumber = await pool.query<{ payroll_check_id: string | null }>(
      `SELECT payroll_check_id FROM payroll_transactions
        WHERE transaction_fingerprint = 'direct-pay-check-same-period-other-number'`,
    );
    expect(otherNumber.rows[0]?.payroll_check_id).toBeNull();

    const movedAway = unwrap(await savePayrollCheck(pool, {
      id: check.id,
      employeeId: employee.id,
      checkNumber: "CHECK-11",
      checkDate: "2026-08-30",
      periodBegin: "2026-08-15",
      periodEnd: "2026-08-29",
      actualGross: "500",
      actualNet: "420",
      taxWithheld: "80",
    }, ACTOR));
    expect(movedAway.linkedTransactions).toBe(0);
    const unlinked = await pool.query<{ payroll_check_id: string | null }>(
      `SELECT payroll_check_id FROM payroll_transactions WHERE transaction_fingerprint = 'direct-pay-check-link'`,
    );
    expect(unlinked.rows[0]?.payroll_check_id).toBeNull();
  });

  it("links blank repeated-NET rows without linking agency-paid rows and is idempotent", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Imported Check Employee" }, ACTOR));
    const program = await pool.query<{ id: string }>(
      `SELECT id FROM programs WHERE payment_recipient = 'employee' ORDER BY code LIMIT 1`,
    );
    expect(program.rows[0]).toBeDefined();
    const file = await pool.query<{ id: string }>(
      `INSERT INTO imported_files (original_filename, byte_size, checksum_sha256)
       VALUES ('imported-checks.xlsx', 1, 'imported-checks-review') RETURNING id`,
    );
    const batch = await pool.query<{ id: string }>(
      `INSERT INTO import_batches (imported_file_id, status)
       VALUES ($1, 'committed') RETURNING id`,
      [file.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, program_id, import_batch_id, check_number, check_date, period_begin, period_end,
          imported_hours, imported_amount, total_net_pay, payment_recipient,
          transaction_fingerprint)
       VALUES
         ($1, $2, $3, 'IMPORT-10', '2026-08-15', '2026-08-01', '2026-08-14',
          10, 250, 420, 'employee', 'import-check-with-net'),
         ($1, $2, $3, 'IMPORT-10', '2026-08-15', '2026-08-01', '2026-08-14',
          10, 250, NULL, 'employee', 'import-check-blank-net'),
         ($1, $2, $3, 'IMPORT-10', '2026-08-15', '2026-08-01', '2026-08-14',
          10, 250, 420, 'excellent_staffing', 'import-check-agency-paid'),
         ($1, $2, $3, 'IMPORT-CONFLICT', '2026-08-30', '2026-08-15', '2026-08-29',
          10, 250, 400, 'employee', 'import-conflict-one'),
         ($1, $2, $3, 'IMPORT-CONFLICT', '2026-08-30', '2026-08-15', '2026-08-29',
          10, 250, 410, 'employee', 'import-conflict-two'),
         ($1, $2, NULL, 'IMPORT-10', '2026-08-15', '2026-08-01', '2026-08-14',
          10, 250, 420, 'employee', 'import-check-manual-row')`,
      [employee.id, program.rows[0]!.id, batch.rows[0]!.id],
    );

    await expect(syncImportedPayrollCheckReviews(pool, null, ACTOR)).resolves.toEqual({
      checks: 1,
      linkedTransactions: 2,
    });
    const linked = await pool.query<{ transaction_fingerprint: string; payroll_check_id: string | null }>(
      `SELECT transaction_fingerprint, payroll_check_id
         FROM payroll_transactions
        WHERE transaction_fingerprint LIKE 'import-check-%'
        ORDER BY transaction_fingerprint`,
    );
    const byFingerprint = new Map(linked.rows.map((row) => [row.transaction_fingerprint, row.payroll_check_id]));
    expect(byFingerprint.get("import-check-with-net")).toBeTruthy();
    expect(byFingerprint.get("import-check-blank-net")).toBe(byFingerprint.get("import-check-with-net"));
    expect(byFingerprint.get("import-check-agency-paid")).toBeNull();
    expect(byFingerprint.get("import-check-manual-row")).toBeNull();
    const conflicting = await pool.query<{ payroll_check_id: string | null }>(
      `SELECT payroll_check_id FROM payroll_transactions
        WHERE transaction_fingerprint LIKE 'import-conflict-%'`,
    );
    expect(conflicting.rows).toEqual([
      { payroll_check_id: null },
      { payroll_check_id: null },
    ]);

    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, program_id, import_batch_id, check_number, check_date, period_begin, period_end,
          imported_hours, imported_amount, total_net_pay, payment_recipient,
          transaction_fingerprint)
       VALUES
         ($1, $2, $3, 'IMPORT-10', '2026-08-15', '2026-08-01', '2026-08-14',
          5, 125, NULL, 'employee', 'import-check-later-blank-net')`,
      [employee.id, program.rows[0]!.id, batch.rows[0]!.id],
    );
    await expect(syncImportedPayrollCheckReviews(pool, null, ACTOR)).resolves.toEqual({
      checks: 0,
      linkedTransactions: 1,
    });
    const laterBlank = await pool.query<{ payroll_check_id: string | null }>(
      `SELECT payroll_check_id FROM payroll_transactions
        WHERE transaction_fingerprint = 'import-check-later-blank-net'`,
    );
    expect(laterBlank.rows[0]?.payroll_check_id).toBe(byFingerprint.get("import-check-with-net"));

    const freshnessBeforeNoop = await pool.query<{ source_version: string }>(
      `SELECT source_version::text FROM settlement_ledger_state WHERE singleton = true`,
    );
    await expect(syncImportedPayrollCheckReviews(pool, null, ACTOR)).resolves.toEqual({
      checks: 0,
      linkedTransactions: 0,
    });
    const freshnessAfterNoop = await pool.query<{ source_version: string }>(
      `SELECT source_version::text FROM settlement_ledger_state WHERE singleton = true`,
    );
    expect(freshnessAfterNoop.rows[0]?.source_version).toBe(freshnessBeforeNoop.rows[0]?.source_version);
  });
});
