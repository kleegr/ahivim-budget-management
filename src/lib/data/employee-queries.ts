import type { PgLikePool } from "@/lib/import/commit";
import { toMoney, toHours } from "@/lib/money";

/**
 * EMPLOYEE WORKSPACE READ MODELS
 * ==============================
 *
 * Additive, employee-scoped read queries that back the Employee workspace tabs.
 * Nothing here changes an existing query; each function is a fresh SELECT.
 *
 * Two invariants carry through, exactly as in queries.ts:
 *
 *  1. Money and hours are selected as ::text and serialised with the money.ts
 *     helpers. A PostgreSQL numeric never becomes a JavaScript float.
 *
 *  2. PHYSICAL hours (time the employee was present — one row per session) and
 *     ALLOCATION hours (the sum of each served individual's entitlement) are two
 *     different quantities and are never merged. A 13-hour group session with
 *     three individuals is 13 physical hours and 39 allocation hours.
 *
 * The payment split (paid directly to the employee vs. payable by the agency,
 * "Excellent Staffing") reads the three attribution columns that
 * payment-attribution.ts back-fills: payment_recipient, employee_payment_amount
 * and agency_additional_amount. Those are null until a back-fill runs, so every
 * function reports how many rows carry an attribution, letting the screen say
 * "not yet attributed" instead of printing a misleading $0.
 */

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

/* -------------------------------------------------------------------------- */
/* Payment summary — the money split for one employee                         */
/* -------------------------------------------------------------------------- */

export interface EmployeePaymentSummary {
  agencyGross: string;
  internalAmount: string;
  agencyAdditional: string;
  /** Total internal amount owed to the employee (paid directly + via agency). */
  totalPayment: string;
  /** Paid straight to the employee (payment_recipient = 'employee'). */
  paidToEmployee: string;
  /** Owed to the employee but routed through the agency ('excellent_staffing'). */
  payableByAgency: string;
  /** Neither classified as direct nor agency ('unknown' or not yet attributed). */
  unknownRecipient: string;
  transactionCount: number;
  /** Rows carrying a non-null payment_recipient. Zero here with transactions
   *  present means the attribution back-fill has not been run yet. */
  attributedCount: number;
  /** Distinct check numbers seen for this employee. */
  checkCount: number;
}

export async function getEmployeePaymentSummary(
  pool: PgLikePool,
  employeeId: string,
): Promise<EmployeePaymentSummary> {
  const empty: EmployeePaymentSummary = {
    agencyGross: toMoney(0),
    internalAmount: toMoney(0),
    agencyAdditional: toMoney(0),
    totalPayment: toMoney(0),
    paidToEmployee: toMoney(0),
    payableByAgency: toMoney(0),
    unknownRecipient: toMoney(0),
    transactionCount: 0,
    attributedCount: 0,
    checkCount: 0,
  };
  if (!isUuid(employeeId)) return empty;

  const { rows } = await pool.query<Record<string, string>>(
    `SELECT
       COALESCE(sum(t.imported_amount), 0)::text                      AS agency_gross,
       COALESCE(sum(t.calculated_internal_amount), 0)::text           AS internal_amount,
       COALESCE(sum(t.agency_additional_amount), 0)::text             AS agency_additional,
       COALESCE(sum(t.employee_payment_amount), 0)::text              AS total_payment,
       COALESCE(sum(t.employee_payment_amount)
         FILTER (WHERE t.payment_recipient = 'employee'), 0)::text     AS paid_to_employee,
       COALESCE(sum(t.employee_payment_amount)
         FILTER (WHERE t.payment_recipient = 'excellent_staffing'), 0)::text AS payable_by_agency,
       COALESCE(sum(t.employee_payment_amount)
         FILTER (WHERE t.payment_recipient = 'unknown'
                    OR t.payment_recipient IS NULL), 0)::text          AS unknown_recipient,
       count(*)::text                                                 AS transaction_count,
       count(*) FILTER (WHERE t.payment_recipient IS NOT NULL)::text  AS attributed_count,
       count(DISTINCT t.check_number)::text                           AS check_count
     FROM payroll_transactions t
     WHERE t.employee_id = $1`,
    [employeeId],
  );
  const r = rows[0] ?? {};
  return {
    agencyGross: toMoney(r.agency_gross ?? 0),
    internalAmount: toMoney(r.internal_amount ?? 0),
    agencyAdditional: toMoney(r.agency_additional ?? 0),
    totalPayment: toMoney(r.total_payment ?? 0),
    paidToEmployee: toMoney(r.paid_to_employee ?? 0),
    payableByAgency: toMoney(r.payable_by_agency ?? 0),
    unknownRecipient: toMoney(r.unknown_recipient ?? 0),
    transactionCount: Number(r.transaction_count ?? 0),
    attributedCount: Number(r.attributed_count ?? 0),
    checkCount: Number(r.check_count ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Individuals this employee has actually served (from the billed ledger)     */
/* -------------------------------------------------------------------------- */

export interface EmployeeIndividualRow {
  id: string;
  displayName: string;
  /** Billed hours (imported_hours) this employee logged for this individual;
   *  reconciles to the Transactions grid filtered to both. */
  allocationHours: string;
  transactionCount: number;
  agencyGross: string;
  internalAmount: string;
}

/**
 * Every individual this employee billed for, with that individual's allocation
 * hours (their entitlement — full hours on a group session) and the money. The
 * allocation join is keyed on BOTH the transaction and the individual, so a
 * group row credits the correct member's hours and nothing is double counted.
 */
export async function getEmployeeIndividuals(
  pool: PgLikePool,
  employeeId: string,
): Promise<EmployeeIndividualRow[]> {
  if (!isUuid(employeeId)) return [];
  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    allocation_hours: string;
    transaction_count: string;
    agency_gross: string;
    internal_amount: string;
  }>(
    `SELECT i.id,
            i.display_name,
            COALESCE(sum(t.imported_hours), 0)::text             AS allocation_hours,
            count(DISTINCT t.id)::text                           AS transaction_count,
            COALESCE(sum(t.imported_amount), 0)::text            AS agency_gross,
            COALESCE(sum(t.calculated_internal_amount), 0)::text AS internal_amount
       FROM payroll_transactions t
       JOIN individuals i ON i.id = t.individual_id
      WHERE t.employee_id = $1
      GROUP BY i.id, i.display_name
      ORDER BY i.display_name`,
    [employeeId],
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    allocationHours: toHours(r.allocation_hours),
    transactionCount: Number(r.transaction_count),
    agencyGross: toMoney(r.agency_gross),
    internalAmount: toMoney(r.internal_amount),
  }));
}

/* -------------------------------------------------------------------------- */
/* This employee's billed activity summarised by program                      */
/* -------------------------------------------------------------------------- */

export interface EmployeeProgramRow {
  programCode: string;
  programName: string;
  /** Time present on this program (service sessions, counted once each). */
  physicalHours: string;
  /** Billed hours (imported_hours) on this program; reconciles to the grid. */
  allocationHours: string;
  transactionCount: number;
  agencyGross: string;
  internalAmount: string;
}

/**
 * Per program: physical hours (from service_sessions, one row per session so a
 * group is counted once), allocation hours (from service_allocations), the money
 * and a transaction count. Physical is a correlated aggregate over the sessions
 * table; the outer aggregate stays over the billed transactions.
 */
export async function getEmployeeUsageByProgram(
  pool: PgLikePool,
  employeeId: string,
): Promise<EmployeeProgramRow[]> {
  if (!isUuid(employeeId)) return [];
  const { rows } = await pool.query<{
    program_code: string;
    program_name: string;
    physical_hours: string;
    allocation_hours: string;
    transaction_count: string;
    agency_gross: string;
    internal_amount: string;
  }>(
    `SELECT p.code AS program_code,
            p.name AS program_name,
            (SELECT COALESCE(sum(s.physical_hours), 0)
               FROM service_sessions s
              WHERE s.employee_id = $1 AND s.program_id = p.id)::text AS physical_hours,
            COALESCE(sum(t.imported_hours), 0)::text                  AS allocation_hours,
            count(DISTINCT t.id)::text                                AS transaction_count,
            COALESCE(sum(t.imported_amount), 0)::text                 AS agency_gross,
            COALESCE(sum(t.calculated_internal_amount), 0)::text      AS internal_amount
       FROM payroll_transactions t
       JOIN programs p ON p.id = t.program_id
      WHERE t.employee_id = $1
      GROUP BY p.id, p.code, p.name
      ORDER BY p.name`,
    [employeeId],
  );
  return rows.map((r) => ({
    programCode: r.program_code,
    programName: r.program_name,
    physicalHours: toHours(r.physical_hours),
    allocationHours: toHours(r.allocation_hours),
    transactionCount: Number(r.transaction_count),
    agencyGross: toMoney(r.agency_gross),
    internalAmount: toMoney(r.internal_amount),
  }));
}

/* -------------------------------------------------------------------------- */
/* Monthly payment history for one employee                                   */
/* -------------------------------------------------------------------------- */

export interface EmployeeMonthlyPaymentRow {
  /** 'YYYY-MM', or null when a transaction has neither a period nor a check date. */
  month: string | null;
  agencyGross: string;
  internalAmount: string;
  totalPayment: string;
  paidToEmployee: string;
  payableByAgency: string;
  checkCount: number;
  transactionCount: number;
}

/**
 * One row per calendar month (service period begin, falling back to check date),
 * newest first, with the money and the direct-vs-agency split. Undated rows fall
 * into a single null-month bucket rather than being dropped.
 */
export async function getEmployeeMonthlyPayments(
  pool: PgLikePool,
  employeeId: string,
): Promise<EmployeeMonthlyPaymentRow[]> {
  if (!isUuid(employeeId)) return [];
  const { rows } = await pool.query<{
    month: string | null;
    agency_gross: string;
    internal_amount: string;
    total_payment: string;
    paid_to_employee: string;
    payable_by_agency: string;
    check_count: string;
    transaction_count: string;
  }>(
    `SELECT to_char(date_trunc('month', COALESCE(t.period_begin, t.check_date)), 'YYYY-MM') AS month,
            COALESCE(sum(t.imported_amount), 0)::text                       AS agency_gross,
            COALESCE(sum(t.calculated_internal_amount), 0)::text            AS internal_amount,
            COALESCE(sum(t.employee_payment_amount), 0)::text               AS total_payment,
            COALESCE(sum(t.employee_payment_amount)
              FILTER (WHERE t.payment_recipient = 'employee'), 0)::text      AS paid_to_employee,
            COALESCE(sum(t.employee_payment_amount)
              FILTER (WHERE t.payment_recipient = 'excellent_staffing'), 0)::text AS payable_by_agency,
            count(DISTINCT t.check_number)::text                            AS check_count,
            count(*)::text                                                  AS transaction_count
       FROM payroll_transactions t
      WHERE t.employee_id = $1
      GROUP BY 1
      ORDER BY 1 DESC NULLS LAST`,
    [employeeId],
  );
  return rows.map((r) => ({
    month: r.month,
    agencyGross: toMoney(r.agency_gross),
    internalAmount: toMoney(r.internal_amount),
    totalPayment: toMoney(r.total_payment),
    paidToEmployee: toMoney(r.paid_to_employee),
    payableByAgency: toMoney(r.payable_by_agency),
    checkCount: Number(r.check_count),
    transactionCount: Number(r.transaction_count),
  }));
}

/* -------------------------------------------------------------------------- */
/* Schedule — delivered vs scheduled, plus upcoming pending sessions          */
/* -------------------------------------------------------------------------- */

export interface EmployeeScheduleSummary {
  pendingSessions: number;
  pendingHours: string;
  completedSessions: number;
  completedHours: string;
  cancelledSessions: number;
  noShowSessions: number;
}

export interface EmployeeUpcomingSession {
  id: string;
  sessionDate: string;
  startTime: string | null;
  durationHours: string;
  status: string;
  isGroup: boolean;
  groupSize: number;
  programName: string;
  expectedInternalAmount: string | null;
  individualNames: string[];
}

export interface EmployeeSchedule {
  summary: EmployeeScheduleSummary;
  upcoming: EmployeeUpcomingSession[];
}

/**
 * A summary of this employee's planned sessions by status (delivered =
 * completed, scheduled = pending) and the next pending sessions from today
 * onward. Physical duration hours are summed once per session; the money shown
 * is each session's expected internal amount.
 */
export async function getEmployeeSchedule(
  pool: PgLikePool,
  employeeId: string,
  upcomingLimit = 50,
): Promise<EmployeeSchedule> {
  const empty: EmployeeSchedule = {
    summary: {
      pendingSessions: 0,
      pendingHours: toHours(0),
      completedSessions: 0,
      completedHours: toHours(0),
      cancelledSessions: 0,
      noShowSessions: 0,
    },
    upcoming: [],
  };
  if (!isUuid(employeeId)) return empty;

  const [summaryRes, upcomingRes] = await Promise.all([
    pool.query<Record<string, string>>(
      `SELECT
         count(*) FILTER (WHERE s.status = 'pending')::text                   AS pending_sessions,
         COALESCE(sum(s.duration_hours) FILTER (WHERE s.status = 'pending'), 0)::text   AS pending_hours,
         count(*) FILTER (WHERE s.status = 'completed')::text                 AS completed_sessions,
         COALESCE(sum(s.duration_hours) FILTER (WHERE s.status = 'completed'), 0)::text AS completed_hours,
         count(*) FILTER (WHERE s.status = 'cancelled')::text                 AS cancelled_sessions,
         count(*) FILTER (WHERE s.status = 'no_show')::text                   AS no_show_sessions
       FROM scheduled_sessions s
       WHERE s.employee_id = $1`,
      [employeeId],
    ),
    pool.query<{
      id: string;
      session_date: string;
      start_time: string | null;
      duration_hours: string;
      status: string;
      is_group: boolean;
      group_size: number;
      program_name: string;
      expected_internal_amount: string | null;
      individual_names: string[] | null;
    }>(
      `SELECT s.id,
              s.session_date::text                 AS session_date,
              s.start_time,
              s.duration_hours::text               AS duration_hours,
              s.status, s.is_group, s.group_size,
              p.name                               AS program_name,
              s.expected_internal_amount::text     AS expected_internal_amount,
              array_agg(i.display_name ORDER BY i.display_name)
                FILTER (WHERE i.display_name IS NOT NULL) AS individual_names
         FROM scheduled_sessions s
         JOIN programs p ON p.id = s.program_id
         LEFT JOIN scheduled_allocations a ON a.scheduled_session_id = s.id
         LEFT JOIN individuals i ON i.id = a.individual_id
        WHERE s.employee_id = $1
          AND s.status = 'pending'
          AND s.session_date >= CURRENT_DATE
        GROUP BY s.id, p.name
        ORDER BY s.session_date, s.start_time NULLS LAST
        LIMIT $2`,
      [employeeId, Math.min(Math.max(1, upcomingLimit), 200)],
    ),
  ]);

  const s = summaryRes.rows[0] ?? {};
  return {
    summary: {
      pendingSessions: Number(s.pending_sessions ?? 0),
      pendingHours: toHours(s.pending_hours ?? 0),
      completedSessions: Number(s.completed_sessions ?? 0),
      completedHours: toHours(s.completed_hours ?? 0),
      cancelledSessions: Number(s.cancelled_sessions ?? 0),
      noShowSessions: Number(s.no_show_sessions ?? 0),
    },
    upcoming: upcomingRes.rows.map((r) => ({
      id: r.id,
      sessionDate: r.session_date,
      startTime: r.start_time,
      durationHours: toHours(r.duration_hours),
      status: r.status,
      isGroup: r.is_group,
      groupSize: r.group_size,
      programName: r.program_name,
      expectedInternalAmount: r.expected_internal_amount === null ? null : toMoney(r.expected_internal_amount),
      individualNames: (r.individual_names ?? []).filter(Boolean),
    })),
  };
}
