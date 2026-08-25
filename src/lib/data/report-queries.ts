import type { PgLikePool } from "@/lib/import/commit";
import { toMoney, toHours } from "@/lib/money";
import {
  listScheduledForReconcile,
  listBilledNotScheduled,
} from "@/lib/manage/reconciliation";

/**
 * Reporting read models.
 *
 * Every figure here is aggregated in SQL with `sum(numeric)` and returned as a
 * decimal string (`::text`); nothing is added as a JavaScript float. The four
 * money quantities the business tracks — AGENCY GROSS, INTERNAL amount, AGENCY
 * ADDITIONAL, and EMPLOYEE PAYMENT — are always carried as SEPARATE columns and
 * never collapsed into one figure. Where a figure cannot be computed (no
 * authorization, no rate) the query returns a real zero with context or a null
 * the screen renders as "Not available", never an unexplained bare 0.
 *
 * These functions only READ. They are additive: existing queries are untouched.
 */

/* -------------------------------------------------------------------------- */
/* Shared normalized shape (used by the report pages and the export routes)   */
/* -------------------------------------------------------------------------- */

export type ReportFieldType = "text" | "date" | "money" | "hours" | "int" | "percent";

export interface ReportColumn {
  key: string;
  header: string;
  type: ReportFieldType;
}

/** A cell is a decimal string (money/hours/percent), a count, or null. */
export type ReportCell = string | number | null;
export type ReportCellRow = Record<string, ReportCell>;

export interface ReportTable {
  key: string;
  /** Present when a report renders more than one table (e.g. missing config). */
  title?: string;
  /** A short line shown when the table is empty. */
  emptyMessage?: string;
  columns: ReportColumn[];
  rows: ReportCellRow[];
}

export interface ReportFilterSpec {
  key: string;
  label: string;
  type: "date" | "int" | "select" | "text";
  options?: { value: string; label: string }[];
  placeholder?: string;
  defaultValue?: string;
}

export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
  filters: ReportFilterSpec[];
  run: (pool: PgLikePool, filters: Record<string, string | undefined>) => Promise<ReportTable[]>;
}

/* -------------------------------------------------------------------------- */
/* Filter parsing helpers                                                     */
/* -------------------------------------------------------------------------- */

const asDate = (v: string | undefined): string | undefined =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;

function asPositiveInt(v: string | undefined, fallback: number, max = 3650): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

const PERIOD_TYPES = new Set(["calendar_year", "rolling_12_month", "custom"]);
const asPeriodType = (v: string | undefined): string | undefined =>
  v && PERIOD_TYPES.has(v) ? v : undefined;

/* -------------------------------------------------------------------------- */
/* 1. Budget utilization                                                      */
/* -------------------------------------------------------------------------- */

export interface BudgetUtilizationRow {
  authorizationId: string;
  individualId: string;
  individualName: string;
  programId: string;
  programCode: string;
  programName: string;
  budgetPeriodId: string;
  periodLabel: string;
  periodType: string;
  startDate: string;
  endDate: string;
  authorizedHours: string;
  usedHours: string;
  scheduledHours: string;
  remainingHours: string;
  remainingAfterScheduledHours: string;
  /** Percent value (0..100+) as a decimal string, or null when unauthorized. */
  percentUsed: string | null;
  percentCommitted: string | null;
}

/**
 * Per individual + program: authorized hours, actual used hours (from
 * service_allocations, where a group member's full-hours entitlement lives),
 * scheduled-but-pending hours, remaining, %used and %committed.
 *
 * The two usage aggregates are LATERAL sub-selects with COALESCE, so an
 * authorization with no usage at all still returns one row of real zeros — the
 * individual is surfaced with context, not hidden by an inner join.
 */
export async function budgetUtilizationReport(
  pool: PgLikePool,
  opts: { periodType?: string } = {},
): Promise<BudgetUtilizationRow[]> {
  const periodType = asPeriodType(opts.periodType) ?? null;
  const { rows } = await pool.query<{
    authorization_id: string;
    individual_id: string;
    individual_name: string;
    program_id: string;
    program_code: string;
    program_name: string;
    budget_period_id: string;
    period_label: string;
    period_type: string;
    start_date: string;
    end_date: string;
    authorized_hours: string;
    used_hours: string;
    scheduled_hours: string;
    remaining_hours: string;
    remaining_after_scheduled_hours: string;
    percent_used: string | null;
    percent_committed: string | null;
  }>(
    `SELECT ba.id                             AS authorization_id,
            ba.individual_id                  AS individual_id,
            i.display_name                    AS individual_name,
            ba.program_id                     AS program_id,
            p.code                            AS program_code,
            p.name                            AS program_name,
            bp.id                             AS budget_period_id,
            bp.label                          AS period_label,
            bp.period_type                    AS period_type,
            bp.start_date::text               AS start_date,
            bp.end_date::text                 AS end_date,
            ba.authorized_hours::text         AS authorized_hours,
            used.h::text                      AS used_hours,
            sched.h::text                     AS scheduled_hours,
            (ba.authorized_hours - used.h)::text                 AS remaining_hours,
            (ba.authorized_hours - used.h - sched.h)::text       AS remaining_after_scheduled_hours,
            CASE WHEN ba.authorized_hours > 0
                 THEN round(used.h / ba.authorized_hours * 100, 4)::text END AS percent_used,
            CASE WHEN ba.authorized_hours > 0
                 THEN round((used.h + sched.h) / ba.authorized_hours * 100, 4)::text END AS percent_committed
     FROM budget_authorizations ba
     JOIN budget_periods bp ON bp.id = ba.budget_period_id
     JOIN individuals i     ON i.id = ba.individual_id
     JOIN programs p        ON p.id = ba.program_id
     CROSS JOIN LATERAL (
       SELECT COALESCE(sum(sa.allocation_hours), 0) AS h
       FROM service_allocations sa
       JOIN service_sessions ss ON ss.id = sa.service_session_id
       WHERE sa.individual_id = ba.individual_id AND ss.program_id = ba.program_id
     ) used
     CROSS JOIN LATERAL (
       SELECT COALESCE(sum(sca.allocation_hours), 0) AS h
       FROM scheduled_allocations sca
       JOIN scheduled_sessions scs ON scs.id = sca.scheduled_session_id
       WHERE sca.individual_id = ba.individual_id AND scs.program_id = ba.program_id
         AND scs.status = 'pending' AND scs.matched_transaction_id IS NULL
     ) sched
     WHERE ba.status = 'active' AND bp.status = 'active'
       AND ($1::text IS NULL OR bp.period_type = $1)
     ORDER BY i.display_name, p.code`,
    [periodType],
  );

  return rows.map((r) => ({
    authorizationId: r.authorization_id,
    individualId: r.individual_id,
    individualName: r.individual_name,
    programId: r.program_id,
    programCode: r.program_code,
    programName: r.program_name,
    budgetPeriodId: r.budget_period_id,
    periodLabel: r.period_label,
    periodType: r.period_type,
    startDate: r.start_date,
    endDate: r.end_date,
    authorizedHours: toHours(r.authorized_hours),
    usedHours: toHours(r.used_hours),
    scheduledHours: toHours(r.scheduled_hours),
    remainingHours: toHours(r.remaining_hours),
    remainingAfterScheduledHours: toHours(r.remaining_after_scheduled_hours),
    percentUsed: r.percent_used,
    percentCommitted: r.percent_committed,
  }));
}

/* -------------------------------------------------------------------------- */
/* 2. Agency earnings (three money columns kept separate)                     */
/* -------------------------------------------------------------------------- */

export interface AgencyEarningsRow {
  programId: string | null;
  programCode: string | null;
  programName: string | null;
  agencyGross: string;
  internalAmount: string;
  agencyAdditional: string;
  transactionCount: number;
}

/**
 * Per program: agency gross, internal amount, and agency additional kept as
 * three separate columns (agency additional = agency gross − internal). Filter
 * on the service period begin date; a null filter means every transaction.
 */
export async function agencyEarningsReport(
  pool: PgLikePool,
  opts: { from?: string; to?: string } = {},
): Promise<AgencyEarningsRow[]> {
  const from = asDate(opts.from) ?? null;
  const to = asDate(opts.to) ?? null;
  const { rows } = await pool.query<{
    program_id: string | null;
    program_code: string | null;
    program_name: string | null;
    agency_gross: string;
    internal_amount: string;
    agency_additional: string;
    transaction_count: string;
  }>(
    `SELECT t.program_id                                        AS program_id,
            p.code                                             AS program_code,
            p.name                                             AS program_name,
            COALESCE(sum(t.imported_amount), 0)::text          AS agency_gross,
            COALESCE(sum(t.calculated_internal_amount), 0)::text AS internal_amount,
            COALESCE(sum(t.agency_additional_amount), 0)::text AS agency_additional,
            count(*)::text                                     AS transaction_count
     FROM payroll_transactions t
     LEFT JOIN programs p ON p.id = t.program_id
     WHERE ($1::date IS NULL OR t.period_begin >= $1)
       AND ($2::date IS NULL OR t.period_begin <= $2)
     GROUP BY t.program_id, p.code, p.name
     ORDER BY p.code NULLS LAST`,
    [from, to],
  );
  return rows.map((r) => ({
    programId: r.program_id,
    programCode: r.program_code,
    programName: r.program_name,
    agencyGross: toMoney(r.agency_gross),
    internalAmount: toMoney(r.internal_amount),
    agencyAdditional: toMoney(r.agency_additional),
    transactionCount: Number(r.transaction_count),
  }));
}

/* -------------------------------------------------------------------------- */
/* 3. Employee payable (split by recipient)                                   */
/* -------------------------------------------------------------------------- */

export interface EmployeePayableRow {
  employeeId: string;
  employeeName: string;
  totalPayment: string;
  paidToEmployee: string;
  payableByAgency: string;
  unknownRecipient: string;
  physicalHours: string;
  checkCount: number;
}

/**
 * Per employee: total employee payment, split three ways by payment_recipient
 * ('employee' paid directly, 'excellent_staffing' payable by the agency, and
 * 'unknown'/unset), plus physical hours and the number of distinct checks. The
 * three recipient buckets always sum to the total.
 */
export async function employeePayableReport(
  pool: PgLikePool,
  opts: { from?: string; to?: string } = {},
): Promise<EmployeePayableRow[]> {
  const from = asDate(opts.from) ?? null;
  const to = asDate(opts.to) ?? null;
  const { rows } = await pool.query<{
    employee_id: string;
    employee_name: string;
    total_payment: string;
    paid_to_employee: string;
    payable_by_agency: string;
    unknown_recipient: string;
    physical_hours: string;
    check_count: string;
  }>(
    `SELECT e.id                                          AS employee_id,
            e.display_name                                AS employee_name,
            COALESCE(sum(t.employee_payment_amount), 0)::text AS total_payment,
            COALESCE(sum(t.employee_payment_amount)
              FILTER (WHERE t.payment_recipient = 'employee'), 0)::text AS paid_to_employee,
            COALESCE(sum(t.employee_payment_amount)
              FILTER (WHERE t.payment_recipient = 'excellent_staffing'), 0)::text AS payable_by_agency,
            COALESCE(sum(t.employee_payment_amount)
              FILTER (WHERE t.payment_recipient = 'unknown' OR t.payment_recipient IS NULL), 0)::text
                                                          AS unknown_recipient,
            COALESCE(sum(t.imported_hours), 0)::text      AS physical_hours,
            count(DISTINCT t.check_number)::text          AS check_count
     FROM employees e
     JOIN payroll_transactions t ON t.employee_id = e.id
     WHERE ($1::date IS NULL OR t.period_begin >= $1)
       AND ($2::date IS NULL OR t.period_begin <= $2)
     GROUP BY e.id, e.display_name
     ORDER BY e.display_name`,
    [from, to],
  );
  return rows.map((r) => ({
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    totalPayment: toMoney(r.total_payment),
    paidToEmployee: toMoney(r.paid_to_employee),
    payableByAgency: toMoney(r.payable_by_agency),
    unknownRecipient: toMoney(r.unknown_recipient),
    physicalHours: toHours(r.physical_hours),
    checkCount: Number(r.check_count),
  }));
}

/* -------------------------------------------------------------------------- */
/* 4. Program totals                                                          */
/* -------------------------------------------------------------------------- */

export interface ProgramTotalsRow {
  programId: string;
  programCode: string;
  programName: string;
  individualsServed: number;
  employees: number;
  actualHours: string;
  agencyGross: string;
  internalAmount: string;
  agencyAdditional: string;
  groupSessions: number;
}

/** Per program: people served, employees, actual hours, money, group sessions. */
export async function programTotalsReport(pool: PgLikePool): Promise<ProgramTotalsRow[]> {
  const { rows } = await pool.query<{
    program_id: string;
    program_code: string;
    program_name: string;
    individuals_served: string;
    employees: string;
    actual_hours: string;
    agency_gross: string;
    internal_amount: string;
    agency_additional: string;
    group_sessions: string;
  }>(
    `SELECT p.id                                            AS program_id,
            p.code                                          AS program_code,
            p.name                                          AS program_name,
            count(DISTINCT t.individual_id)::text           AS individuals_served,
            count(DISTINCT t.employee_id)::text             AS employees,
            COALESCE(sum(t.imported_hours), 0)::text        AS actual_hours,
            COALESCE(sum(t.imported_amount), 0)::text       AS agency_gross,
            COALESCE(sum(t.calculated_internal_amount), 0)::text AS internal_amount,
            COALESCE(sum(t.agency_additional_amount), 0)::text   AS agency_additional,
            (SELECT count(*) FROM service_sessions ss
              WHERE ss.program_id = p.id
                AND ss.group_detection_status = 'detected')::text AS group_sessions
     FROM programs p
     LEFT JOIN payroll_transactions t ON t.program_id = p.id
     GROUP BY p.id, p.code, p.name
     ORDER BY p.code`,
  );
  return rows.map((r) => ({
    programId: r.program_id,
    programCode: r.program_code,
    programName: r.program_name,
    individualsServed: Number(r.individuals_served),
    employees: Number(r.employees),
    actualHours: toHours(r.actual_hours),
    agencyGross: toMoney(r.agency_gross),
    internalAmount: toMoney(r.internal_amount),
    agencyAdditional: toMoney(r.agency_additional),
    groupSessions: Number(r.group_sessions),
  }));
}

/* -------------------------------------------------------------------------- */
/* 5. Expiring authorizations                                                 */
/* -------------------------------------------------------------------------- */

export interface ExpiringAuthorizationRow {
  authorizationId: string;
  individualId: string;
  individualName: string;
  programCode: string;
  programName: string;
  periodLabel: string;
  endDate: string;
  renewalDate: string | null;
  daysRemaining: number;
  authorizedHours: string;
  usedHours: string;
}

/**
 * Authorizations whose budget period end_date or renewal_date falls within the
 * next N days (default 60). daysRemaining counts to the nearest of the two
 * upcoming dates. Used hours come from service_allocations, like utilization.
 */
export async function expiringAuthorizationsReport(
  pool: PgLikePool,
  opts: { withinDays?: number } = {},
): Promise<ExpiringAuthorizationRow[]> {
  const withinDays = opts.withinDays && opts.withinDays > 0 ? Math.min(opts.withinDays, 3650) : 60;
  const { rows } = await pool.query<{
    authorization_id: string;
    individual_id: string;
    individual_name: string;
    program_code: string;
    program_name: string;
    period_label: string;
    end_date: string;
    renewal_date: string | null;
    days_remaining: number;
    authorized_hours: string;
    used_hours: string;
  }>(
    `SELECT ba.id                     AS authorization_id,
            ba.individual_id          AS individual_id,
            i.display_name            AS individual_name,
            p.code                    AS program_code,
            p.name                    AS program_name,
            bp.label                  AS period_label,
            bp.end_date::text         AS end_date,
            bp.renewal_date::text     AS renewal_date,
            (LEAST(
               CASE WHEN bp.end_date     >= CURRENT_DATE THEN bp.end_date END,
               CASE WHEN bp.renewal_date >= CURRENT_DATE THEN bp.renewal_date END
             ) - CURRENT_DATE)        AS days_remaining,
            ba.authorized_hours::text AS authorized_hours,
            used.h::text              AS used_hours
     FROM budget_authorizations ba
     JOIN budget_periods bp ON bp.id = ba.budget_period_id
     JOIN individuals i     ON i.id = ba.individual_id
     JOIN programs p        ON p.id = ba.program_id
     CROSS JOIN LATERAL (
       SELECT COALESCE(sum(sa.allocation_hours), 0) AS h
       FROM service_allocations sa
       JOIN service_sessions ss ON ss.id = sa.service_session_id
       WHERE sa.individual_id = ba.individual_id AND ss.program_id = ba.program_id
     ) used
     WHERE ba.status = 'active' AND bp.status = 'active'
       AND (
         (bp.end_date     >= CURRENT_DATE AND bp.end_date     <= CURRENT_DATE + $1::int) OR
         (bp.renewal_date >= CURRENT_DATE AND bp.renewal_date <= CURRENT_DATE + $1::int)
       )
     ORDER BY days_remaining NULLS LAST, i.display_name, p.code`,
    [withinDays],
  );
  return rows.map((r) => ({
    authorizationId: r.authorization_id,
    individualId: r.individual_id,
    individualName: r.individual_name,
    programCode: r.program_code,
    programName: r.program_name,
    periodLabel: r.period_label,
    endDate: r.end_date,
    renewalDate: r.renewal_date,
    daysRemaining: Number(r.days_remaining),
    authorizedHours: toHours(r.authorized_hours),
    usedHours: toHours(r.used_hours),
  }));
}

/* -------------------------------------------------------------------------- */
/* 6. Missing configuration                                                   */
/* -------------------------------------------------------------------------- */

export interface MissingRateRow {
  programId: string;
  programCode: string;
  programName: string;
}
export interface MissingAssignmentRow {
  individualId: string;
  individualName: string;
  programsAuthorized: string | null;
}
export interface MissingConfigReport {
  missingRates: MissingRateRow[];
  missingAssignments: MissingAssignmentRow[];
}

/**
 * Two gaps that quietly break downstream figures:
 *   - active programs with no rate schedule in force today, and
 *   - active individuals with an active authorization but no active assignment.
 */
export async function missingConfigReport(pool: PgLikePool): Promise<MissingConfigReport> {
  const [rateRes, assignRes] = await Promise.all([
    pool.query<{ program_id: string; program_code: string; program_name: string }>(
      `SELECT p.id AS program_id, p.code AS program_code, p.name AS program_name
       FROM programs p
       WHERE p.is_active = true AND p.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM program_rate_schedules r
           WHERE r.program_id = p.id
             AND r.effective_from <= CURRENT_DATE
             AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE)
         )
       ORDER BY p.code`,
    ),
    pool.query<{ individual_id: string; individual_name: string; programs_authorized: string | null }>(
      `SELECT i.id AS individual_id, i.display_name AS individual_name,
              (SELECT string_agg(DISTINCT p.code, ', ' ORDER BY p.code)
                 FROM budget_authorizations ba
                 JOIN programs p ON p.id = ba.program_id
                WHERE ba.individual_id = i.id AND ba.status = 'active') AS programs_authorized
       FROM individuals i
       WHERE i.status = 'active'
         AND EXISTS (SELECT 1 FROM budget_authorizations ba
                      WHERE ba.individual_id = i.id AND ba.status = 'active')
         AND NOT EXISTS (SELECT 1 FROM assignments a
                          WHERE a.individual_id = i.id AND a.status = 'active')
       ORDER BY i.display_name`,
    ),
  ]);
  return {
    missingRates: rateRes.rows.map((r) => ({
      programId: r.program_id,
      programCode: r.program_code,
      programName: r.program_name,
    })),
    missingAssignments: assignRes.rows.map((r) => ({
      individualId: r.individual_id,
      individualName: r.individual_name,
      programsAuthorized: r.programs_authorized,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Dashboard headline metrics (counts + the two extra money figures)          */
/* -------------------------------------------------------------------------- */

export interface DashboardReportMetrics {
  agencyAdditional: { amount: string; available: boolean };
  employeePayable: { amount: string; available: boolean };
  counts: {
    nearExhaustion: number;
    underutilizing: number;
    expiringAuthorizations: number;
    unbilledSchedules: number;
    unscheduledBilling: number;
    missingRates: number;
    missingAssignments: number;
  };
}

/**
 * The extra figures the redesigned dashboard tiles need, in one round trip.
 * Money is summed in SQL and returned as text. "available" is false when there
 * ARE transactions but none carry the figure, so the tile can say why rather
 * than print a misleading $0.
 */
export async function dashboardReportMetrics(pool: PgLikePool): Promise<DashboardReportMetrics> {
  const { rows } = await pool.query<{
    near_exhaustion: string;
    underutilizing: string;
    agency_additional: string;
    agency_additional_rows: string;
    employee_payable: string;
    employee_payable_rows: string;
    transaction_rows: string;
    expiring_auth: string;
    unbilled_schedules: string;
    unscheduled_billing: string;
    missing_rates: string;
    missing_assignments: string;
  }>(
    `WITH util AS (
       SELECT ba.authorized_hours AS auth, bp.start_date, bp.end_date,
              (SELECT COALESCE(sum(sa.allocation_hours), 0)
                 FROM service_allocations sa
                 JOIN service_sessions ss ON ss.id = sa.service_session_id
                WHERE sa.individual_id = ba.individual_id AND ss.program_id = ba.program_id) AS used,
              (SELECT COALESCE(sum(sca.allocation_hours), 0)
                 FROM scheduled_allocations sca
                 JOIN scheduled_sessions scs ON scs.id = sca.scheduled_session_id
                WHERE sca.individual_id = ba.individual_id AND scs.program_id = ba.program_id
                  AND scs.status = 'pending'
                  AND scs.matched_transaction_id IS NULL) AS sched
       FROM budget_authorizations ba
       JOIN budget_periods bp ON bp.id = ba.budget_period_id
       WHERE ba.status = 'active' AND bp.status = 'active'
     )
     SELECT
       (SELECT count(*) FROM util
          WHERE auth > 0 AND (used + sched) >= auth * 0.9)::text                       AS near_exhaustion,
       (SELECT count(*) FROM util
          WHERE auth > 0 AND end_date > start_date
            AND (CURRENT_DATE - start_date)::numeric / (end_date - start_date) >= 0.5
            AND (used + sched) < auth * 0.5)::text                                      AS underutilizing,
       (SELECT COALESCE(sum(agency_additional_amount), 0) FROM payroll_transactions)::text AS agency_additional,
       (SELECT count(*) FROM payroll_transactions WHERE agency_additional_amount IS NOT NULL)::text AS agency_additional_rows,
       (SELECT COALESCE(sum(employee_payment_amount), 0) FROM payroll_transactions)::text AS employee_payable,
       (SELECT count(*) FROM payroll_transactions WHERE employee_payment_amount IS NOT NULL)::text AS employee_payable_rows,
       (SELECT count(*) FROM payroll_transactions)::text                                AS transaction_rows,
       (SELECT count(*) FROM budget_authorizations ba
          JOIN budget_periods bp ON bp.id = ba.budget_period_id
         WHERE ba.status = 'active' AND bp.status = 'active'
           AND ((bp.end_date     >= CURRENT_DATE AND bp.end_date     <= CURRENT_DATE + 60) OR
                (bp.renewal_date >= CURRENT_DATE AND bp.renewal_date <= CURRENT_DATE + 60)))::text AS expiring_auth,
       (SELECT count(*) FROM scheduled_sessions
         WHERE status = 'pending' AND matched_transaction_id IS NULL)::text             AS unbilled_schedules,
       (SELECT count(*) FROM payroll_transactions t
         WHERE NOT EXISTS (SELECT 1 FROM scheduled_sessions s WHERE s.matched_transaction_id = t.id))::text
                                                                                        AS unscheduled_billing,
       (SELECT count(*) FROM programs p
         WHERE p.is_active AND p.archived_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM program_rate_schedules r
                            WHERE r.program_id = p.id AND r.effective_from <= CURRENT_DATE
                              AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE)))::text AS missing_rates,
       (SELECT count(*) FROM individuals i
         WHERE i.status = 'active'
           AND EXISTS (SELECT 1 FROM budget_authorizations ba
                        WHERE ba.individual_id = i.id AND ba.status = 'active')
           AND NOT EXISTS (SELECT 1 FROM assignments a
                            WHERE a.individual_id = i.id AND a.status = 'active'))::text AS missing_assignments`,
  );
  const r = rows[0]!;
  const txRows = Number(r.transaction_rows ?? 0);
  return {
    agencyAdditional: {
      amount: toMoney(r.agency_additional ?? 0),
      available: txRows === 0 || Number(r.agency_additional_rows ?? 0) > 0,
    },
    employeePayable: {
      amount: toMoney(r.employee_payable ?? 0),
      available: txRows === 0 || Number(r.employee_payable_rows ?? 0) > 0,
    },
    counts: {
      nearExhaustion: Number(r.near_exhaustion ?? 0),
      underutilizing: Number(r.underutilizing ?? 0),
      expiringAuthorizations: Number(r.expiring_auth ?? 0),
      unbilledSchedules: Number(r.unbilled_schedules ?? 0),
      unscheduledBilling: Number(r.unscheduled_billing ?? 0),
      missingRates: Number(r.missing_rates ?? 0),
      missingAssignments: Number(r.missing_assignments ?? 0),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 7. Cuts & monthly calculation                                              */
/* -------------------------------------------------------------------------- */

export interface CutsMonthlyRow {
  calculationId: string;
  individualName: string;
  programCode: string | null;
  programName: string | null;
  annualGross: string | null;
  monthlyGross: string | null;
  cut1Amount: string | null;
  cut2Amount: string | null;
  clockAdjustment: string | null;
  finalGross: string | null;
  finalNet: string | null;
  afterAll: string | null;
  spreadsheetValue: string | null;
  /** spreadsheet value − system After All; null when either is absent. */
  difference: string | null;
}

/**
 * One row per ACTIVE calculation: the whole waterfall (annual/monthly gross,
 * both cuts, clock adjustment, final gross/net, After All) plus the stored
 * spreadsheet value and the difference against the system After All. Money is
 * carried as decimal strings; null figures stay null so the screen shows
 * "Not available" rather than a fabricated 0.
 */
export async function cutsMonthlyReport(
  pool: PgLikePool,
  opts: { program?: string } = {},
): Promise<CutsMonthlyRow[]> {
  const program = (opts.program ?? "").trim() || null;
  const { rows } = await pool.query<{
    calculation_id: string;
    individual_name: string;
    program_code: string | null;
    program_name: string | null;
    annual_gross: string | null;
    monthly_gross: string | null;
    cut1_amount: string | null;
    cut2_amount: string | null;
    clock_adjustment: string | null;
    final_gross: string | null;
    final_net: string | null;
    after_all: string | null;
    spreadsheet_value: string | null;
    difference: string | null;
  }>(
    `SELECT c.id                       AS calculation_id,
            i.display_name             AS individual_name,
            p.code                     AS program_code,
            p.name                     AS program_name,
            c.annual_gross::text       AS annual_gross,
            c.monthly_gross::text      AS monthly_gross,
            c.cut1_amount::text        AS cut1_amount,
            c.cut2_amount::text        AS cut2_amount,
            c.clock_adjustment::text   AS clock_adjustment,
            c.final_gross::text        AS final_gross,
            c.final_net::text          AS final_net,
            c.after_all::text          AS after_all,
            c.spreadsheet_value::text  AS spreadsheet_value,
            CASE WHEN c.spreadsheet_value IS NOT NULL AND c.after_all IS NOT NULL
                 THEN (c.spreadsheet_value - c.after_all)::text END AS difference
     FROM budget_calculations c
     JOIN individuals i ON i.id = c.individual_id
     LEFT JOIN programs p ON p.id = c.program_id
     WHERE c.status = 'active'
       AND ($1::text IS NULL OR p.code ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%')
     ORDER BY i.display_name, p.code NULLS FIRST`,
    [program],
  );
  const money = (v: string | null) => (v === null ? null : toMoney(v));
  return rows.map((r) => ({
    calculationId: r.calculation_id,
    individualName: r.individual_name,
    programCode: r.program_code,
    programName: r.program_name,
    annualGross: money(r.annual_gross),
    monthlyGross: money(r.monthly_gross),
    cut1Amount: money(r.cut1_amount),
    cut2Amount: money(r.cut2_amount),
    clockAdjustment: money(r.clock_adjustment),
    finalGross: money(r.final_gross),
    finalNet: money(r.final_net),
    afterAll: money(r.after_all),
    spreadsheetValue: money(r.spreadsheet_value),
    difference: money(r.difference),
  }));
}

/* -------------------------------------------------------------------------- */
/* 8. Alias decisions                                                         */
/* -------------------------------------------------------------------------- */

export interface AliasDecisionRow {
  sourceText: string;
  normalizedAlias: string;
  canonicalName: string;
  /** 'individual' | 'employee' */
  kind: string;
  status: string;
  approvedBy: string | null;
  createdAt: string;
}

/**
 * Every individual and employee alias in one list: the imported spelling, its
 * normalized form, the canonical name it resolves to, its kind and status, who
 * approved it and the date it was created. Filterable by kind and status.
 */
export async function aliasDecisionsReport(
  pool: PgLikePool,
  opts: { kind?: string; status?: string } = {},
): Promise<AliasDecisionRow[]> {
  const kind = opts.kind === "individual" || opts.kind === "employee" ? opts.kind : null;
  const status = opts.status === "pending" || opts.status === "approved" ? opts.status : null;
  const { rows } = await pool.query<{
    source_text: string;
    normalized_alias: string;
    canonical_name: string;
    kind: string;
    status: string;
    approved_by: string | null;
    created_at: string;
  }>(
    `SELECT x.source_text, x.normalized_alias, x.canonical_name, x.kind, x.status,
            x.approved_by, x.created_at
     FROM (
       SELECT ia.source_text, ia.normalized_alias, i.display_name AS canonical_name,
              'individual'::text AS kind, ia.status,
              u.display_name AS approved_by, ia.created_at::date::text AS created_at
       FROM individual_aliases ia
       JOIN individuals i ON i.id = ia.individual_id
       LEFT JOIN users u ON u.id = ia.approved_by_user_id
       UNION ALL
       SELECT ea.source_text, ea.normalized_alias, e.display_name,
              'employee'::text, ea.status,
              u.display_name, ea.created_at::date::text
       FROM employee_aliases ea
       JOIN employees e ON e.id = ea.employee_id
       LEFT JOIN users u ON u.id = ea.approved_by_user_id
     ) x
     WHERE ($1::text IS NULL OR x.kind = $1)
       AND ($2::text IS NULL OR x.status = $2)
     ORDER BY x.kind, x.canonical_name, x.source_text`,
    [kind, status],
  );
  return rows.map((r) => ({
    sourceText: r.source_text,
    normalizedAlias: r.normalized_alias,
    canonicalName: r.canonical_name,
    kind: r.kind,
    status: r.status,
    approvedBy: r.approved_by,
    createdAt: r.created_at,
  }));
}

/* -------------------------------------------------------------------------- */
/* 9. Audit history                                                           */
/* -------------------------------------------------------------------------- */

export interface AuditHistoryRow {
  timestamp: string;
  actor: string | null;
  action: string;
  entityType: string | null;
  reason: string | null;
}

/**
 * The most recent 500 audit entries with the actor's display name and the
 * reason recorded in the metadata (metadata->>'reason'). An optional exact
 * `action` filter narrows to a single action.
 */
export async function auditHistoryReport(
  pool: PgLikePool,
  opts: { action?: string } = {},
): Promise<AuditHistoryRow[]> {
  const action = (opts.action ?? "").trim() || null;
  const { rows } = await pool.query<{
    ts: string;
    actor: string | null;
    action: string;
    entity_type: string | null;
    reason: string | null;
  }>(
    `SELECT to_char(a.created_at, 'YYYY-MM-DD HH24:MI') AS ts,
            u.display_name                              AS actor,
            a.action                                    AS action,
            a.entity_type                               AS entity_type,
            a.metadata->>'reason'                       AS reason
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE ($1::text IS NULL OR a.action = $1)
     ORDER BY a.created_at DESC
     LIMIT 500`,
    [action],
  );
  return rows.map((r) => ({
    timestamp: r.ts,
    actor: r.actor,
    action: r.action,
    entityType: r.entity_type,
    reason: r.reason,
  }));
}

/* -------------------------------------------------------------------------- */
/* 10. Group activity                                                         */
/* -------------------------------------------------------------------------- */

export interface GroupServiceRow {
  serviceSessionId: string;
  programCode: string | null;
  programName: string | null;
  employeeName: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  groupSize: number;
  memberCount: number;
  combinedAmount: string | null;
  detectionStatus: string;
}
export interface ScheduledGroupCountRow {
  programCode: string | null;
  programName: string | null;
  sessionCount: number;
}
export interface GroupActivityReport {
  sessions: GroupServiceRow[];
  scheduledCounts: ScheduledGroupCountRow[];
}

/**
 * Group service sessions (service_sessions with group_size > 1): program,
 * employee, period, group size, member count from service_allocations, and the
 * COMBINED amount kept whole — never re-split here. A companion aggregate counts
 * planned group sessions per program. Filterable by period and program.
 */
export async function groupActivityReport(
  pool: PgLikePool,
  opts: { from?: string; to?: string; program?: string } = {},
): Promise<GroupActivityReport> {
  const from = asDate(opts.from) ?? null;
  const to = asDate(opts.to) ?? null;
  const program = (opts.program ?? "").trim() || null;

  const sessionsRes = await pool.query<{
    service_session_id: string;
    program_code: string | null;
    program_name: string | null;
    employee_name: string | null;
    period_begin: string | null;
    period_end: string | null;
    group_size: number;
    member_count: string;
    combined_amount: string | null;
    group_detection_status: string;
  }>(
    `SELECT ss.id                       AS service_session_id,
            p.code                       AS program_code,
            p.name                       AS program_name,
            e.display_name               AS employee_name,
            ss.period_begin::text        AS period_begin,
            ss.period_end::text          AS period_end,
            ss.group_size                AS group_size,
            (SELECT count(*) FROM service_allocations sa
              WHERE sa.service_session_id = ss.id)::text AS member_count,
            ss.combined_amount::text     AS combined_amount,
            ss.group_detection_status    AS group_detection_status
     FROM service_sessions ss
     LEFT JOIN programs p  ON p.id = ss.program_id
     LEFT JOIN employees e ON e.id = ss.employee_id
     WHERE ss.group_size > 1
       AND ($1::date IS NULL OR ss.period_begin >= $1)
       AND ($2::date IS NULL OR ss.period_begin <= $2)
       AND ($3::text IS NULL OR p.code ILIKE '%' || $3 || '%' OR p.name ILIKE '%' || $3 || '%')
     ORDER BY ss.period_begin NULLS LAST, p.code`,
    [from, to, program],
  );

  const countsRes = await pool.query<{
    program_code: string | null;
    program_name: string | null;
    session_count: string;
  }>(
    `SELECT p.code AS program_code, p.name AS program_name, count(*)::text AS session_count
     FROM scheduled_sessions s
     LEFT JOIN programs p ON p.id = s.program_id
     WHERE (s.is_group = true OR s.group_size > 1)
       AND s.status IN ('pending', 'completed')
       AND ($1::date IS NULL OR s.session_date >= $1)
       AND ($2::date IS NULL OR s.session_date <= $2)
       AND ($3::text IS NULL OR p.code ILIKE '%' || $3 || '%' OR p.name ILIKE '%' || $3 || '%')
     GROUP BY p.code, p.name
     ORDER BY p.code NULLS LAST`,
    [from, to, program],
  );

  return {
    sessions: sessionsRes.rows.map((r) => ({
      serviceSessionId: r.service_session_id,
      programCode: r.program_code,
      programName: r.program_name,
      employeeName: r.employee_name,
      periodBegin: r.period_begin,
      periodEnd: r.period_end,
      groupSize: Number(r.group_size),
      memberCount: Number(r.member_count),
      combinedAmount: r.combined_amount === null ? null : toMoney(r.combined_amount),
      detectionStatus: r.group_detection_status,
    })),
    scheduledCounts: countsRes.rows.map((r) => ({
      programCode: r.program_code,
      programName: r.program_name,
      sessionCount: Number(r.session_count),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* 11. Actual vs scheduled                                                    */
/* -------------------------------------------------------------------------- */

export interface ActualVsScheduledRow {
  individualId: string;
  individualName: string;
  programCode: string | null;
  programName: string | null;
  scheduledHours: string;
  scheduledInternal: string;
  actualHours: string;
  actualInternal: string;
  hoursVariance: string;
  internalVariance: string;
}

/**
 * Per individual + program: scheduled hours and expected internal (from
 * scheduled_allocations on pending/completed sessions) set against actual hours
 * and internal (from service_allocations), with the variance (actual − scheduled)
 * for both hours and money. A UNION of the two key sets means a pair that is only
 * scheduled, or only actual, still appears with real zeros on the missing side.
 */
export async function actualVsScheduledReport(
  pool: PgLikePool,
  opts: { program?: string } = {},
): Promise<ActualVsScheduledRow[]> {
  const program = (opts.program ?? "").trim() || null;
  const { rows } = await pool.query<{
    individual_id: string;
    individual_name: string;
    program_code: string | null;
    program_name: string | null;
    scheduled_hours: string;
    scheduled_internal: string;
    actual_hours: string;
    actual_internal: string;
    hours_variance: string;
    internal_variance: string;
  }>(
    `WITH sched AS (
       SELECT sa.individual_id, s.program_id,
              COALESCE(sum(sa.allocation_hours), 0) AS hours,
              COALESCE(sum(sa.allocated_amount), 0) AS internal
       FROM scheduled_allocations sa
       JOIN scheduled_sessions s ON s.id = sa.scheduled_session_id
       WHERE s.status IN ('pending', 'completed')
       GROUP BY sa.individual_id, s.program_id
     ),
     actual AS (
       SELECT al.individual_id, ss.program_id,
              COALESCE(sum(al.allocation_hours), 0) AS hours,
              COALESCE(sum(al.allocated_amount), 0) AS internal
       FROM service_allocations al
       JOIN service_sessions ss ON ss.id = al.service_session_id
       GROUP BY al.individual_id, ss.program_id
     ),
     keys AS (
       SELECT individual_id, program_id FROM sched
       UNION
       SELECT individual_id, program_id FROM actual
     )
     SELECT k.individual_id                                    AS individual_id,
            i.display_name                                     AS individual_name,
            p.code                                             AS program_code,
            p.name                                             AS program_name,
            COALESCE(s.hours, 0)::text                         AS scheduled_hours,
            COALESCE(s.internal, 0)::text                      AS scheduled_internal,
            COALESCE(a.hours, 0)::text                         AS actual_hours,
            COALESCE(a.internal, 0)::text                      AS actual_internal,
            (COALESCE(a.hours, 0) - COALESCE(s.hours, 0))::text       AS hours_variance,
            (COALESCE(a.internal, 0) - COALESCE(s.internal, 0))::text AS internal_variance
     FROM keys k
     JOIN individuals i ON i.id = k.individual_id
     LEFT JOIN programs p ON p.id = k.program_id
     LEFT JOIN sched s ON s.individual_id = k.individual_id
                      AND s.program_id IS NOT DISTINCT FROM k.program_id
     LEFT JOIN actual a ON a.individual_id = k.individual_id
                       AND a.program_id IS NOT DISTINCT FROM k.program_id
     WHERE ($1::text IS NULL OR p.code ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%')
     ORDER BY i.display_name, p.code NULLS FIRST`,
    [program],
  );
  return rows.map((r) => ({
    individualId: r.individual_id,
    individualName: r.individual_name,
    programCode: r.program_code,
    programName: r.program_name,
    scheduledHours: toHours(r.scheduled_hours),
    scheduledInternal: toMoney(r.scheduled_internal),
    actualHours: toHours(r.actual_hours),
    actualInternal: toMoney(r.actual_internal),
    hoursVariance: toHours(r.hours_variance),
    internalVariance: toMoney(r.internal_variance),
  }));
}

/* -------------------------------------------------------------------------- */
/* 12. Utilization outliers                                                   */
/* -------------------------------------------------------------------------- */

export interface UtilizationOutlierRow {
  authorizationId: string;
  individualId: string;
  individualName: string;
  programCode: string;
  programName: string;
  periodLabel: string;
  authorizedHours: string;
  usedHours: string;
  remainingHours: string;
  percentUsed: string | null;
  /** 'underutilizing' | 'overutilizing' */
  flag: string;
}

/**
 * Authorizations that are utilization outliers: OVER-utilizing (> 100% of the
 * authorized hours already used) or UNDER-utilizing (< 50% used once more than
 * half the period has elapsed). Used hours come from service_allocations, like
 * the utilization report. Filterable by flag and program; only outliers appear.
 */
export async function utilizationOutliersReport(
  pool: PgLikePool,
  opts: { flag?: string; program?: string } = {},
): Promise<UtilizationOutlierRow[]> {
  const flag =
    opts.flag === "underutilizing" || opts.flag === "overutilizing" ? opts.flag : null;
  const program = (opts.program ?? "").trim() || null;
  const { rows } = await pool.query<{
    authorization_id: string;
    individual_id: string;
    individual_name: string;
    program_code: string;
    program_name: string;
    period_label: string;
    authorized_hours: string;
    used_hours: string;
    remaining_hours: string;
    percent_used: string | null;
    flag: string;
  }>(
    `SELECT * FROM (
       SELECT ba.id                       AS authorization_id,
              ba.individual_id            AS individual_id,
              i.display_name              AS individual_name,
              p.code                      AS program_code,
              p.name                      AS program_name,
              bp.label                    AS period_label,
              ba.authorized_hours::text   AS authorized_hours,
              used.h::text                AS used_hours,
              (ba.authorized_hours - used.h)::text AS remaining_hours,
              CASE WHEN ba.authorized_hours > 0
                   THEN round(used.h / ba.authorized_hours * 100, 4)::text END AS percent_used,
              CASE
                WHEN ba.authorized_hours > 0 AND used.h > ba.authorized_hours
                  THEN 'overutilizing'
                WHEN ba.authorized_hours > 0 AND used.h < ba.authorized_hours * 0.5
                     AND bp.end_date > bp.start_date
                     AND (CURRENT_DATE - bp.start_date)::numeric / (bp.end_date - bp.start_date) > 0.5
                  THEN 'underutilizing'
                ELSE 'ok'
              END                         AS flag
       FROM budget_authorizations ba
       JOIN budget_periods bp ON bp.id = ba.budget_period_id
       JOIN individuals i     ON i.id = ba.individual_id
       JOIN programs p        ON p.id = ba.program_id
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(sa.allocation_hours), 0) AS h
         FROM service_allocations sa
         JOIN service_sessions ss ON ss.id = sa.service_session_id
         WHERE sa.individual_id = ba.individual_id AND ss.program_id = ba.program_id
       ) used
       WHERE ba.status = 'active' AND bp.status = 'active'
     ) x
     WHERE x.flag <> 'ok'
       AND ($1::text IS NULL OR x.flag = $1)
       AND ($2::text IS NULL OR x.program_code ILIKE '%' || $2 || '%' OR x.program_name ILIKE '%' || $2 || '%')
     ORDER BY x.flag, x.individual_name, x.program_code`,
    [flag, program],
  );
  return rows.map((r) => ({
    authorizationId: r.authorization_id,
    individualId: r.individual_id,
    individualName: r.individual_name,
    programCode: r.program_code,
    programName: r.program_name,
    periodLabel: r.period_label,
    authorizedHours: toHours(r.authorized_hours),
    usedHours: toHours(r.used_hours),
    remainingHours: toHours(r.remaining_hours),
    percentUsed: r.percent_used,
    flag: r.flag,
  }));
}

/* -------------------------------------------------------------------------- */
/* Report registry: one definition drives the page table AND the export       */
/* -------------------------------------------------------------------------- */

const DATE_FILTERS: ReportFilterSpec[] = [
  { key: "from", label: "From", type: "date" },
  { key: "to", label: "To", type: "date" },
];

export const REPORTS: Record<string, ReportDefinition> = {
  "budget-utilization": {
    key: "budget-utilization",
    title: "Budget utilization",
    description:
      "Authorized, used and scheduled hours per individual and program, with the percent used and the percent committed once the current schedule is honored.",
    filters: [
      {
        key: "periodType",
        label: "Period type",
        type: "select",
        options: [
          { value: "", label: "All period types" },
          { value: "calendar_year", label: "Calendar year" },
          { value: "rolling_12_month", label: "Rolling 12 month" },
          { value: "custom", label: "Custom" },
        ],
      },
    ],
    async run(pool, filters) {
      const rows = await budgetUtilizationReport(pool, { periodType: filters.periodType });
      return [
        {
          key: "budget-utilization",
          emptyMessage: "No active authorizations match this filter.",
          columns: [
            { key: "individualName", header: "Individual", type: "text" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "periodLabel", header: "Period", type: "text" },
            { key: "authorizedHours", header: "Authorized", type: "hours" },
            { key: "usedHours", header: "Used", type: "hours" },
            { key: "scheduledHours", header: "Scheduled", type: "hours" },
            { key: "remainingHours", header: "Remaining", type: "hours" },
            { key: "percentUsed", header: "% used", type: "percent" },
            { key: "percentCommitted", header: "% committed", type: "percent" },
          ],
          rows: rows.map((r) => ({
            individualName: r.individualName,
            programCode: r.programCode,
            periodLabel: r.periodLabel,
            authorizedHours: r.authorizedHours,
            usedHours: r.usedHours,
            scheduledHours: r.scheduledHours,
            remainingHours: r.remainingHours,
            percentUsed: r.percentUsed,
            percentCommitted: r.percentCommitted,
          })),
        },
      ];
    },
  },

  "agency-earnings": {
    key: "agency-earnings",
    title: "Agency earnings",
    description:
      "Agency gross, internal amount and agency additional per program, kept as three separate columns. Agency additional is agency gross less internal.",
    filters: DATE_FILTERS,
    async run(pool, filters) {
      const rows = await agencyEarningsReport(pool, { from: filters.from, to: filters.to });
      return [
        {
          key: "agency-earnings",
          emptyMessage: "No transactions fall in this date range.",
          columns: [
            { key: "programName", header: "Program", type: "text" },
            { key: "agencyGross", header: "Agency gross", type: "money" },
            { key: "internalAmount", header: "Internal amount", type: "money" },
            { key: "agencyAdditional", header: "Agency additional", type: "money" },
            { key: "transactionCount", header: "Transactions", type: "int" },
          ],
          rows: rows.map((r) => ({
            programName: r.programName ?? r.programCode ?? "Unassigned",
            agencyGross: r.agencyGross,
            internalAmount: r.internalAmount,
            agencyAdditional: r.agencyAdditional,
            transactionCount: r.transactionCount,
          })),
        },
      ];
    },
  },

  "employee-payable": {
    key: "employee-payable",
    title: "Employee payable",
    description:
      "Employee payment per employee, split by who it is paid to: directly to the employee, payable by the agency (Excellent Staffing), or an unresolved recipient.",
    filters: DATE_FILTERS,
    async run(pool, filters) {
      const rows = await employeePayableReport(pool, { from: filters.from, to: filters.to });
      return [
        {
          key: "employee-payable",
          emptyMessage: "No employee payments fall in this date range.",
          columns: [
            { key: "employeeName", header: "Employee", type: "text" },
            { key: "totalPayment", header: "Total payment", type: "money" },
            { key: "paidToEmployee", header: "Paid to employee", type: "money" },
            { key: "payableByAgency", header: "Payable by agency", type: "money" },
            { key: "unknownRecipient", header: "Unresolved", type: "money" },
            { key: "physicalHours", header: "Physical hours", type: "hours" },
            { key: "checkCount", header: "Checks", type: "int" },
          ],
          rows: rows.map((r) => ({
            employeeName: r.employeeName,
            totalPayment: r.totalPayment,
            paidToEmployee: r.paidToEmployee,
            payableByAgency: r.payableByAgency,
            unknownRecipient: r.unknownRecipient,
            physicalHours: r.physicalHours,
            checkCount: r.checkCount,
          })),
        },
      ];
    },
  },

  "program-totals": {
    key: "program-totals",
    title: "Program totals",
    description:
      "Individuals served, employees, actual hours, agency gross, internal amount and group sessions for every program.",
    filters: [],
    async run(pool) {
      const rows = await programTotalsReport(pool);
      return [
        {
          key: "program-totals",
          emptyMessage: "No programs are configured.",
          columns: [
            { key: "programName", header: "Program", type: "text" },
            { key: "individualsServed", header: "Individuals", type: "int" },
            { key: "employees", header: "Employees", type: "int" },
            { key: "actualHours", header: "Actual hours", type: "hours" },
            { key: "agencyGross", header: "Agency gross", type: "money" },
            { key: "internalAmount", header: "Internal amount", type: "money" },
            { key: "agencyAdditional", header: "Agency additional", type: "money" },
            { key: "groupSessions", header: "Group sessions", type: "int" },
          ],
          rows: rows.map((r) => ({
            programName: r.programName,
            individualsServed: r.individualsServed,
            employees: r.employees,
            actualHours: r.actualHours,
            agencyGross: r.agencyGross,
            internalAmount: r.internalAmount,
            agencyAdditional: r.agencyAdditional,
            groupSessions: r.groupSessions,
          })),
        },
      ];
    },
  },

  "expiring-authorizations": {
    key: "expiring-authorizations",
    title: "Expiring authorizations",
    description:
      "Authorizations whose budget period ends or renews within the chosen window, with days remaining and authorized versus used hours.",
    filters: [
      { key: "withinDays", label: "Within days", type: "int", defaultValue: "60", placeholder: "60" },
    ],
    async run(pool, filters) {
      const rows = await expiringAuthorizationsReport(pool, {
        withinDays: asPositiveInt(filters.withinDays, 60),
      });
      return [
        {
          key: "expiring-authorizations",
          emptyMessage: "No authorizations expire or renew in this window.",
          columns: [
            { key: "individualName", header: "Individual", type: "text" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "endDate", header: "Ends", type: "date" },
            { key: "renewalDate", header: "Renews", type: "date" },
            { key: "daysRemaining", header: "Days left", type: "int" },
            { key: "authorizedHours", header: "Authorized", type: "hours" },
            { key: "usedHours", header: "Used", type: "hours" },
          ],
          rows: rows.map((r) => ({
            individualName: r.individualName,
            programCode: r.programCode,
            endDate: r.endDate,
            renewalDate: r.renewalDate,
            daysRemaining: r.daysRemaining,
            authorizedHours: r.authorizedHours,
            usedHours: r.usedHours,
          })),
        },
      ];
    },
  },

  "missing-config": {
    key: "missing-config",
    title: "Missing configuration",
    description:
      "Configuration gaps that quietly distort figures: programs with no current rate, and active individuals with an authorization but no assignment.",
    filters: [],
    async run(pool) {
      const report = await missingConfigReport(pool);
      return [
        {
          key: "missing-rates",
          title: "Programs with no current rate",
          emptyMessage: "Every active program has a rate in force.",
          columns: [
            { key: "programCode", header: "Code", type: "text" },
            { key: "programName", header: "Program", type: "text" },
          ],
          rows: report.missingRates.map((r) => ({
            programCode: r.programCode,
            programName: r.programName,
          })),
        },
        {
          key: "missing-assignments",
          title: "Active authorization but no assignment",
          emptyMessage: "Every authorized individual has an active assignment.",
          columns: [
            { key: "individualName", header: "Individual", type: "text" },
            { key: "programsAuthorized", header: "Authorized programs", type: "text" },
          ],
          rows: report.missingAssignments.map((r) => ({
            individualName: r.individualName,
            programsAuthorized: r.programsAuthorized,
          })),
        },
      ];
    },
  },

  "unbilled-schedules": {
    key: "unbilled-schedules",
    title: "Unbilled schedules",
    description:
      "Planned sessions in the date range that have not been matched to an imported transaction. Group sessions are surfaced but never auto-matched.",
    filters: DATE_FILTERS,
    async run(pool, filters) {
      const lines = await listScheduledForReconcile(
        pool,
        { from: filters.from ?? "", to: filters.to ?? "" },
        true,
        500,
      );
      return [
        {
          key: "unbilled-schedules",
          emptyMessage: "No unmatched planned sessions in this range.",
          columns: [
            { key: "sessionDate", header: "Date", type: "date" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "individuals", header: "Individuals", type: "text" },
            { key: "isGroup", header: "Group", type: "text" },
            { key: "hours", header: "Hours", type: "hours" },
            { key: "expectedInternal", header: "Expected internal", type: "money" },
          ],
          rows: lines.map((l) => ({
            sessionDate: l.sessionDate,
            programCode: l.programCode,
            individuals: l.individualNames.join(", "),
            isGroup: l.isGroup ? "Group" : "1:1",
            hours: l.hours,
            expectedInternal: l.expectedInternal,
          })),
        },
      ];
    },
  },

  "unscheduled-billing": {
    key: "unscheduled-billing",
    title: "Unscheduled billing",
    description:
      "Imported transactions in the date range with no matching planned session, so billing occurred that the schedule did not anticipate.",
    filters: DATE_FILTERS,
    async run(pool, filters) {
      const lines = await listBilledNotScheduled(
        pool,
        { from: filters.from ?? "", to: filters.to ?? "" },
        500,
      );
      return [
        {
          key: "unscheduled-billing",
          emptyMessage: "Every transaction in this range matches a planned session.",
          columns: [
            { key: "periodBegin", header: "Period begin", type: "date" },
            { key: "periodEnd", header: "Period end", type: "date" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "individualName", header: "Individual", type: "text" },
            { key: "hours", header: "Hours", type: "hours" },
            { key: "amount", header: "Agency gross", type: "money" },
          ],
          rows: lines.map((l) => ({
            periodBegin: l.periodBegin,
            periodEnd: l.periodEnd,
            programCode: l.programCode,
            individualName: l.individualName,
            hours: l.hours,
            amount: l.amount,
          })),
        },
      ];
    },
  },

  "cuts-monthly": {
    key: "cuts-monthly",
    title: "Cuts & monthly calculation",
    description:
      "Every active calculation's waterfall — annual and monthly gross, both cuts, the clock adjustment, final gross and net, Masser (the fixed set-aside) — beside the spreadsheet value and their difference.",
    filters: [{ key: "program", label: "Program", type: "text", placeholder: "Code or name" }],
    async run(pool, filters) {
      const rows = await cutsMonthlyReport(pool, { program: filters.program });
      return [
        {
          key: "cuts-monthly",
          emptyMessage: "No active calculations match this filter.",
          columns: [
            { key: "individualName", header: "Individual", type: "text" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "annualGross", header: "Annual gross", type: "money" },
            { key: "monthlyGross", header: "Monthly gross", type: "money" },
            { key: "cut1Amount", header: "Cut 1", type: "money" },
            { key: "cut2Amount", header: "Cut 2", type: "money" },
            { key: "clockAdjustment", header: "Clock adj.", type: "money" },
            { key: "finalGross", header: "Final gross", type: "money" },
            { key: "finalNet", header: "Final net", type: "money" },
            { key: "afterAll", header: "Masser", type: "money" },
            { key: "spreadsheetValue", header: "Spreadsheet", type: "money" },
            { key: "difference", header: "Difference", type: "money" },
          ],
          rows: rows.map((r) => ({
            individualName: r.individualName,
            programCode: r.programCode,
            annualGross: r.annualGross,
            monthlyGross: r.monthlyGross,
            cut1Amount: r.cut1Amount,
            cut2Amount: r.cut2Amount,
            clockAdjustment: r.clockAdjustment,
            finalGross: r.finalGross,
            finalNet: r.finalNet,
            afterAll: r.afterAll,
            spreadsheetValue: r.spreadsheetValue,
            difference: r.difference,
          })),
        },
      ];
    },
  },

  "alias-decisions": {
    key: "alias-decisions",
    title: "Alias decisions",
    description:
      "Every individual and employee alias — the imported spelling, its normalized form, the canonical name it resolves to, its kind and status, who approved it and when.",
    filters: [
      {
        key: "kind",
        label: "Kind",
        type: "select",
        options: [
          { value: "", label: "All kinds" },
          { value: "individual", label: "Individual" },
          { value: "employee", label: "Employee" },
        ],
      },
      {
        key: "status",
        label: "Status",
        type: "select",
        options: [
          { value: "", label: "All statuses" },
          { value: "pending", label: "Pending" },
          { value: "approved", label: "Approved" },
        ],
      },
    ],
    async run(pool, filters) {
      const rows = await aliasDecisionsReport(pool, { kind: filters.kind, status: filters.status });
      return [
        {
          key: "alias-decisions",
          emptyMessage: "No aliases match this filter.",
          columns: [
            { key: "sourceText", header: "Imported spelling", type: "text" },
            { key: "normalizedAlias", header: "Normalized", type: "text" },
            { key: "canonicalName", header: "Canonical", type: "text" },
            { key: "kind", header: "Kind", type: "text" },
            { key: "status", header: "Status", type: "text" },
            { key: "approvedBy", header: "Approved by", type: "text" },
            { key: "createdAt", header: "Created", type: "date" },
          ],
          rows: rows.map((r) => ({
            sourceText: r.sourceText,
            normalizedAlias: r.normalizedAlias,
            canonicalName: r.canonicalName,
            kind: r.kind,
            status: r.status,
            approvedBy: r.approvedBy,
            createdAt: r.createdAt,
          })),
        },
      ];
    },
  },

  "audit-history": {
    key: "audit-history",
    title: "Audit history",
    description:
      "The most recent 500 audit entries — when, who, which action, on what entity, and the reason recorded with the change. Filter by a specific action.",
    filters: [{ key: "action", label: "Action", type: "text", placeholder: "e.g. calculation_saved" }],
    async run(pool, filters) {
      const rows = await auditHistoryReport(pool, { action: filters.action });
      return [
        {
          key: "audit-history",
          emptyMessage: "No audit entries match this filter.",
          columns: [
            { key: "timestamp", header: "When", type: "text" },
            { key: "actor", header: "Actor", type: "text" },
            { key: "action", header: "Action", type: "text" },
            { key: "entityType", header: "Entity", type: "text" },
            { key: "reason", header: "Reason", type: "text" },
          ],
          rows: rows.map((r) => ({
            timestamp: r.timestamp,
            actor: r.actor,
            action: r.action,
            entityType: r.entityType,
            reason: r.reason,
          })),
        },
      ];
    },
  },

  "group-activity": {
    key: "group-activity",
    title: "Group activity",
    description:
      "Group service sessions (more than one individual) with their combined amount kept whole and their member count, plus a count of planned group sessions per program.",
    filters: [
      ...DATE_FILTERS,
      { key: "program", label: "Program", type: "text", placeholder: "Code or name" },
    ],
    async run(pool, filters) {
      const data = await groupActivityReport(pool, {
        from: filters.from,
        to: filters.to,
        program: filters.program,
      });
      return [
        {
          key: "group-services",
          title: "Group service sessions",
          emptyMessage: "No group service sessions in this range.",
          columns: [
            { key: "programCode", header: "Program", type: "text" },
            { key: "employeeName", header: "Employee", type: "text" },
            { key: "periodBegin", header: "Period begin", type: "date" },
            { key: "periodEnd", header: "Period end", type: "date" },
            { key: "groupSize", header: "Group size", type: "int" },
            { key: "memberCount", header: "Members", type: "int" },
            { key: "combinedAmount", header: "Combined amount", type: "money" },
            { key: "detectionStatus", header: "Detection", type: "text" },
          ],
          rows: data.sessions.map((r) => ({
            programCode: r.programCode,
            employeeName: r.employeeName,
            periodBegin: r.periodBegin,
            periodEnd: r.periodEnd,
            groupSize: r.groupSize,
            memberCount: r.memberCount,
            combinedAmount: r.combinedAmount,
            detectionStatus: r.detectionStatus,
          })),
        },
        {
          key: "scheduled-group-counts",
          title: "Planned group sessions",
          emptyMessage: "No planned group sessions in this range.",
          columns: [
            { key: "programCode", header: "Program", type: "text" },
            { key: "programName", header: "Program name", type: "text" },
            { key: "sessionCount", header: "Planned group sessions", type: "int" },
          ],
          rows: data.scheduledCounts.map((r) => ({
            programCode: r.programCode,
            programName: r.programName,
            sessionCount: r.sessionCount,
          })),
        },
      ];
    },
  },

  "actual-vs-scheduled": {
    key: "actual-vs-scheduled",
    title: "Actual vs scheduled",
    description:
      "Per individual and program: scheduled hours and expected internal set against actual hours and internal, with the variance (actual minus scheduled) for both.",
    filters: [{ key: "program", label: "Program", type: "text", placeholder: "Code or name" }],
    async run(pool, filters) {
      const rows = await actualVsScheduledReport(pool, { program: filters.program });
      return [
        {
          key: "actual-vs-scheduled",
          emptyMessage: "No scheduled or actual activity to compare.",
          columns: [
            { key: "individualName", header: "Individual", type: "text" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "scheduledHours", header: "Scheduled hours", type: "hours" },
            { key: "actualHours", header: "Actual hours", type: "hours" },
            { key: "hoursVariance", header: "Hours variance", type: "hours" },
            { key: "scheduledInternal", header: "Scheduled internal", type: "money" },
            { key: "actualInternal", header: "Actual internal", type: "money" },
            { key: "internalVariance", header: "Internal variance", type: "money" },
          ],
          rows: rows.map((r) => ({
            individualName: r.individualName,
            programCode: r.programCode,
            scheduledHours: r.scheduledHours,
            actualHours: r.actualHours,
            hoursVariance: r.hoursVariance,
            scheduledInternal: r.scheduledInternal,
            actualInternal: r.actualInternal,
            internalVariance: r.internalVariance,
          })),
        },
      ];
    },
  },

  "utilization-outliers": {
    key: "utilization-outliers",
    title: "Utilization outliers",
    description:
      "Authorizations under-utilizing (below 50% used past the halfway point of the period) or over-utilizing (over 100% used), with authorized, used and remaining hours and the flag.",
    filters: [
      {
        key: "flag",
        label: "Flag",
        type: "select",
        options: [
          { value: "", label: "All outliers" },
          { value: "underutilizing", label: "Under-utilizing" },
          { value: "overutilizing", label: "Over-utilizing" },
        ],
      },
      { key: "program", label: "Program", type: "text", placeholder: "Code or name" },
    ],
    async run(pool, filters) {
      const rows = await utilizationOutliersReport(pool, {
        flag: filters.flag,
        program: filters.program,
      });
      return [
        {
          key: "utilization-outliers",
          emptyMessage: "No authorizations are outliers right now.",
          columns: [
            { key: "individualName", header: "Individual", type: "text" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "periodLabel", header: "Period", type: "text" },
            { key: "authorizedHours", header: "Authorized", type: "hours" },
            { key: "usedHours", header: "Used", type: "hours" },
            { key: "remainingHours", header: "Remaining", type: "hours" },
            { key: "percentUsed", header: "% used", type: "percent" },
            { key: "flag", header: "Flag", type: "text" },
          ],
          rows: rows.map((r) => ({
            individualName: r.individualName,
            programCode: r.programCode,
            periodLabel: r.periodLabel,
            authorizedHours: r.authorizedHours,
            usedHours: r.usedHours,
            remainingHours: r.remainingHours,
            percentUsed: r.percentUsed,
            flag: r.flag,
          })),
        },
      ];
    },
  },
};

export const REPORT_KEYS = Object.keys(REPORTS);

export function isReportKey(key: string | undefined): key is string {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(REPORTS, key);
}

/** Pull just the recognised filter values for a report out of a query bag. */
export function selectFilters(
  key: string,
  raw: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const def = REPORTS[key];
  if (!def) return {};
  const out: Record<string, string | undefined> = {};
  for (const spec of def.filters) {
    const v = raw[spec.key];
    out[spec.key] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}
