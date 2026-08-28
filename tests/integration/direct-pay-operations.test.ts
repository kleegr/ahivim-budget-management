import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { createEmployee } from "@/lib/manage/employees";
import {
  archiveDirectPayTarget,
  saveDirectPayTarget,
  savePayrollCheck,
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
          10, 250, 'employee', 'direct-pay-check-explicit-employee')`,
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
});
