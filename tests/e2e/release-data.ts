import type { PgLikePool } from "../../src/lib/import/commit";
import { createStrategy, updateStrategy } from "../../src/lib/manage/calculation-strategies";
import { savePayrollCheck } from "../../src/lib/manage/direct-pay-operations";
import { saveEmployeeDeal } from "../../src/lib/manage/employee-deals";
import { createSession } from "../../src/lib/manage/schedule";
import { refreshSettlementObligations } from "../../src/lib/manage/settlements";
import {
  ACTIVITY_DATE,
  ACTIVITY_PERIOD_BEGIN,
  ACTIVITY_PERIOD_END,
  AGENCY_CHECK_NUMBER,
  AGENCY_TRANSACTION_ID,
  CURRENT_BUDGET_LABEL,
  DIRECT_CHECK_NUMBER,
  DIRECT_TRANSACTION_ONE_ID,
  DIRECT_TRANSACTION_TWO_ID,
  FUTURE_SESSION_DATE,
  HISTORICAL_BUDGET_LABEL,
  LINKED_EMPLOYEE_ID,
  LINKED_INDIVIDUAL_ID,
  PRIMARY_CALCULATION_ACCOUNT,
  SECONDARY_CALCULATION_ACCOUNT,
} from "./fixtures";

type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function unwrap<T>(label: string, result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`${label}: ${result.code}: ${result.message}`);
  return result.data;
}

interface ProgramRateRow {
  id: string;
  name: string;
  agency_rate: string | null;
  internal_rate: string;
}

const DIRECT_SESSION_ONE_ID = "50000000-0000-4000-8000-000000000001";
const DIRECT_SESSION_TWO_ID = "50000000-0000-4000-8000-000000000002";
const AGENCY_SESSION_ID = "50000000-0000-4000-8000-000000000003";

/**
 * Small, linked, production-shaped truth set for the release acceptance spec.
 * The values intentionally exercise check-level de-duplication: two direct-pay
 * source rows carry the same whole-check NET and link to one canonical check.
 */
export async function seedReleaseAcceptanceData(
  pool: PgLikePool,
  actorId: string,
): Promise<{ transactions: number; strategies: number; sessions: number; obligations: number }> {
  const programResult = await pool.query<ProgramRateRow>(
    `SELECT program.id, program.name,
            rate.agency_rate::text, rate.internal_rate::text
       FROM programs program
       JOIN LATERAL (
         SELECT schedule.agency_rate, schedule.internal_rate
           FROM program_rate_schedules schedule
          WHERE schedule.program_id = program.id
            AND schedule.effective_from <= $1::date
            AND (schedule.effective_to IS NULL OR schedule.effective_to >= $1::date)
          ORDER BY schedule.effective_from DESC
          LIMIT 1
       ) rate ON true
      WHERE program.code = 'COM_HAB'
        AND program.is_active = true`,
    [ACTIVITY_DATE],
  );
  const program = programResult.rows[0];
  if (!program?.agency_rate) {
    throw new Error("Release acceptance seed requires the configured COM_HAB agency and internal rates.");
  }

  const periodResult = await pool.query<{ id: string; label: string }>(
    `INSERT INTO budget_periods
       (individual_id, label, start_date, end_date, period_type, renewal_date,
        planning_months, status, source, notes)
     VALUES
       ($1, $2, '2026-01-01', '2026-12-31', 'calendar', '2027-01-01',
        12, 'active', 'e2e-release-acceptance', 'Current release-acceptance authorization'),
       ($1, $3, '2025-01-01', '2025-12-31', 'calendar', '2026-01-01',
        12, 'active', 'e2e-release-acceptance', 'Historical release-acceptance authorization')
     RETURNING id, label`,
    [LINKED_INDIVIDUAL_ID, CURRENT_BUDGET_LABEL, HISTORICAL_BUDGET_LABEL],
  );
  const currentPeriodId = periodResult.rows.find((row) => row.label === CURRENT_BUDGET_LABEL)?.id;
  const historicalPeriodId = periodResult.rows.find((row) => row.label === HISTORICAL_BUDGET_LABEL)?.id;
  if (!currentPeriodId || !historicalPeriodId) {
    throw new Error("Release acceptance budget periods were not created.");
  }

  await pool.query(
    `INSERT INTO budget_authorizations
       (budget_period_id, individual_id, program_id, authorized_hours,
        internal_rate, authorized_dollars, agency_rate, rate_basis, source,
        source_row_ref, notes, created_by_user_id)
     VALUES
       ($1, $3, $4, 100, $5, $6::numeric * 100, $6,
        'program_schedule', 'e2e-release-acceptance', 'e2e-current-com-hab',
        '100 current hours at the configured rate', $7),
       ($2, $3, $4, 80, $5, $6::numeric * 80, $6,
        'program_schedule', 'e2e-release-acceptance', 'e2e-history-com-hab',
        '80 historical hours at the configured rate', $7)`,
    [
      currentPeriodId,
      historicalPeriodId,
      LINKED_INDIVIDUAL_ID,
      program.id,
      program.internal_rate,
      program.agency_rate,
      actorId,
    ],
  );

  await pool.query(
    `INSERT INTO assignments
       (employee_id, individual_id, program_id, start_date, end_date,
        allowed_hours, status, notes, created_by_user_id)
     VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 100, 'active',
             'Release acceptance staffing assignment', $4)`,
    [LINKED_EMPLOYEE_ID, LINKED_INDIVIDUAL_ID, program.id, actorId],
  );

  unwrap("employee deal", await saveEmployeeDeal(pool, {
    employeeId: LINKED_EMPLOYEE_ID,
    directRule: "giveback_percent",
    directPercent: "0.10",
    agencyCutPercent: "0.20",
    effectiveFrom: "2026-01-01",
    notes: "Release acceptance direct and agency-routed terms",
    reason: "Seed the documented release acceptance agreement",
  }, actorId));

  await pool.query(
    `INSERT INTO payroll_transactions
       (id, source_row_number, pay_to_raw, check_number, check_date,
        period_begin, period_end, individual_id, employee_id, program_id,
        individual_raw, employee_raw, program_raw, imported_hours,
        imported_rate, imported_amount, total_net_pay,
        spreadsheet_internal_amount, calculated_internal_amount,
        internal_rate_applied, agency_rate_applied, agency_additional_amount,
        employee_payment_amount, payment_recipient, transaction_fingerprint)
     VALUES
       ($1, 101, 'Linked Employee', $4, $6, $7, $8, $9, $10, $11,
        'Linked Individual', 'Linked Employee', 'COM_HAB', 5,
        $12, $12::numeric * 5, 240, $13::numeric * 5, $13::numeric * 5,
        $13, $12, ($12::numeric - $13::numeric) * 5, $13::numeric * 5,
        'employee', 'e2e-direct-row-1'),
       ($2, 102, 'Linked Employee', $4, $6, $7, $8, $9, $10, $11,
        'Linked Individual', 'Linked Employee', 'COM_HAB', 5,
        $12, $12::numeric * 5, 240, $13::numeric * 5, $13::numeric * 5,
        $13, $12, ($12::numeric - $13::numeric) * 5, $13::numeric * 5,
        'employee', 'e2e-direct-row-2'),
       ($3, 103, 'E2E Provider Agency', $5, $6, $7, $8, $9, $10, $11,
        'Linked Individual', 'Linked Employee', 'COM_HAB', 4,
        $12, $12::numeric * 4, NULL, $13::numeric * 4, $13::numeric * 4,
        $13, $12, ($12::numeric - $13::numeric) * 4, $13::numeric * 4,
        'excellent_staffing', 'e2e-agency-row-1')`,
    [
      DIRECT_TRANSACTION_ONE_ID,
      DIRECT_TRANSACTION_TWO_ID,
      AGENCY_TRANSACTION_ID,
      DIRECT_CHECK_NUMBER,
      AGENCY_CHECK_NUMBER,
      ACTIVITY_DATE,
      ACTIVITY_PERIOD_BEGIN,
      ACTIVITY_PERIOD_END,
      LINKED_INDIVIDUAL_ID,
      LINKED_EMPLOYEE_ID,
      program.id,
      program.agency_rate,
      program.internal_rate,
    ],
  );

  // Mirror the import pipeline's physical-session/allocation model so the
  // Employee 360 profile exercises its real physical-hours query as well as
  // its transaction-backed allocation totals.
  await pool.query(
    `INSERT INTO service_sessions
       (id, employee_id, program_id, check_number, period_begin, period_end,
        physical_hours, group_size, combined_rate, combined_amount,
        base_individual_rate, group_detection_status, detection_rule,
        detection_signature, confidence, validation_result, source_row_refs)
     VALUES
       ($1, $4, $5, $6, $8, $9, 5, 1, $10, $10::numeric * 5,
        $10, 'single', 'e2e_release_acceptance', 'e2e-service-101', 1,
        '{"valid":true}'::jsonb, '[101]'::jsonb),
       ($2, $4, $5, $6, $8, $9, 5, 1, $10, $10::numeric * 5,
        $10, 'single', 'e2e_release_acceptance', 'e2e-service-102', 1,
        '{"valid":true}'::jsonb, '[102]'::jsonb),
       ($3, $4, $5, $7, $8, $9, 4, 1, $10, $10::numeric * 4,
        $10, 'single', 'e2e_release_acceptance', 'e2e-service-103', 1,
        '{"valid":true}'::jsonb, '[103]'::jsonb)`,
    [
      DIRECT_SESSION_ONE_ID,
      DIRECT_SESSION_TWO_ID,
      AGENCY_SESSION_ID,
      LINKED_EMPLOYEE_ID,
      program.id,
      DIRECT_CHECK_NUMBER,
      AGENCY_CHECK_NUMBER,
      ACTIVITY_PERIOD_BEGIN,
      ACTIVITY_PERIOD_END,
      program.agency_rate,
    ],
  );
  await pool.query(
    `UPDATE payroll_transactions AS target
        SET service_session_id = mapping.session_id,
            is_group_service = false,
            updated_at = now()
       FROM (VALUES
         ($1::uuid, $4::uuid),
         ($2::uuid, $5::uuid),
         ($3::uuid, $6::uuid)
       ) AS mapping(transaction_id, session_id)
      WHERE target.id = mapping.transaction_id`,
    [
      DIRECT_TRANSACTION_ONE_ID,
      DIRECT_TRANSACTION_TWO_ID,
      AGENCY_TRANSACTION_ID,
      DIRECT_SESSION_ONE_ID,
      DIRECT_SESSION_TWO_ID,
      AGENCY_SESSION_ID,
    ],
  );
  await pool.query(
    `INSERT INTO service_allocations
       (service_session_id, individual_id, payroll_transaction_id,
        allocation_hours, allocated_rate, allocated_amount, rounding_adjustment)
     VALUES
       ($1, $4, $5, 5, $8, $8::numeric * 5, 0),
       ($2, $4, $6, 5, $8, $8::numeric * 5, 0),
       ($3, $4, $7, 4, $8, $8::numeric * 4, 0)`,
    [
      DIRECT_SESSION_ONE_ID,
      DIRECT_SESSION_TWO_ID,
      AGENCY_SESSION_ID,
      LINKED_INDIVIDUAL_ID,
      DIRECT_TRANSACTION_ONE_ID,
      DIRECT_TRANSACTION_TWO_ID,
      AGENCY_TRANSACTION_ID,
      program.agency_rate,
    ],
  );

  const payrollCheck = unwrap("payroll check", await savePayrollCheck(pool, {
    employeeId: LINKED_EMPLOYEE_ID,
    checkNumber: DIRECT_CHECK_NUMBER,
    checkDate: ACTIVITY_DATE,
    periodBegin: ACTIVITY_PERIOD_BEGIN,
    periodEnd: ACTIVITY_PERIOD_END,
    actualGross: "300",
    actualNet: "240",
    taxWithheld: "60",
    sourceRef: "E2E-CHECK-001",
    verificationStatus: "verified",
    notes: "One verified check linked to two repeated-NET source rows",
    sourceTransactionIds: [DIRECT_TRANSACTION_ONE_ID, DIRECT_TRANSACTION_TWO_ID],
  }, actorId));
  if (payrollCheck.linkedTransactions !== 2) {
    throw new Error("Release acceptance payroll check did not link both direct-pay rows.");
  }

  const primary = unwrap("primary financial setup", await createStrategy(pool, {
    individualId: LINKED_INDIVIDUAL_ID,
    label: "Core supports",
  }, actorId));
  unwrap("primary financial setup values", await updateStrategy(pool, {
    id: primary.id,
    renewalDate: "2027-01-01",
    monthDivisor: "12",
    cut1Percent: "0.10",
    cut2Percent: "0.05",
    afterAll: "175",
    account: PRIMARY_CALCULATION_ACCOUNT,
    notes: "Primary approved monthly release-acceptance amount",
    hours: { [program.id]: "60" },
  }, actorId, "Seed primary release acceptance setup"));

  const secondary = unwrap("secondary financial setup", await createStrategy(pool, {
    individualId: LINKED_INDIVIDUAL_ID,
    label: "Supplemental supports",
  }, actorId));
  unwrap("secondary financial setup values", await updateStrategy(pool, {
    id: secondary.id,
    renewalDate: "2027-01-01",
    monthDivisor: "12",
    cut1Percent: "0.05",
    cut2Percent: "0",
    afterAll: "85",
    account: SECONDARY_CALCULATION_ACCOUNT,
    notes: "Secondary approved monthly release-acceptance amount",
    hours: { [program.id]: "40" },
  }, actorId, "Seed secondary release acceptance setup"));

  unwrap("future scheduled visit", await createSession(pool, {
    employeeId: LINKED_EMPLOYEE_ID,
    programId: program.id,
    individualIds: [LINKED_INDIVIDUAL_ID],
    serviceType: program.name,
    sessionDate: FUTURE_SESSION_DATE,
    startTime: "09:00",
    endTime: "11:00",
    durationHours: "2",
    source: "manual",
    notes: "Release acceptance future visit",
  }, actorId, "Seed a production-shaped future visit"));

  const refreshed = unwrap(
    "settlement ledger refresh",
    await refreshSettlementObligations(pool, {}, actorId),
  );
  const obligationCount = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM settlement_obligations WHERE status = 'active'`,
  );

  return {
    transactions: 3,
    strategies: 2,
    sessions: 1,
    obligations: Number(obligationCount.rows[0]?.count ?? refreshed.created),
  };
}
