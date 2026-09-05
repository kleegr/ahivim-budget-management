import type { PgLikePool } from "@/lib/import/commit";
import { dec, toMoney, toHours } from "@/lib/money";
import { listStrategies } from "@/lib/manage/calculation-strategies";
import {
  listScheduledForReconcile,
  listBilledNotScheduled,
} from "@/lib/manage/reconciliation";
import { agencyDate, agencyMonth } from "@/lib/business/agency-time";
import { fullAccess } from "@/lib/auth/access";
import { getCollectionsWorkspace } from "@/lib/data/direct-pay-operations";
import { listTransactionsForGrid } from "@/lib/data/transactions-grid";
import {
  listCurrentProgramBudgets,
  type ProgramBudgetRecord,
} from "@/lib/data/program-budgets";
import {
  billingWithoutBudgetReport,
  employeeActivityReport,
  importConflictsReport,
  mergeHistoryReport,
  moneyOperationsReport,
  transactionEmployeeBase,
  transactionSourceHref,
  transactionsReport,
  unverifiedChecksReport,
} from "@/lib/data/report-completeness";
import { txLink } from "@/lib/nav/tx-link";

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
  /** Render a relative URL cell as this friendly link; export keeps the URL. */
  linkLabel?: string;
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
  /** Closest truthful workspace behind this table's totals. */
  source?: { href: string; label: string };
  /** Material scope or completeness disclosure displayed above the grid. */
  note?: string;
  columns: ReportColumn[];
  rows: ReportCellRow[];
}

export interface ReportFilterSpec {
  key: string;
  label: string;
  type: "date" | "month" | "int" | "select" | "text";
  options?: { value: string; label: string }[];
  placeholder?: string;
  defaultValue?: string;
}

/* -------------------------------------------------------------------------- */
/* Payroll checks and individual put-away                                     */
/* -------------------------------------------------------------------------- */

export interface PayrollChecksReportOptions {
  periodFrom?: string;
  periodTo?: string;
  checkDate?: string;
  checkNumber?: string;
  employee?: string;
  individual?: string;
  program?: string;
  recipient?: string;
}

/**
 * Transaction-level payroll/check detail composed from the same canonical
 * ledger projection used by Transactions. Keeping one row per committed
 * transaction makes every displayed amount traceable to its source record.
 */
export async function payrollChecksReport(
  pool: PgLikePool,
  opts: PayrollChecksReportOptions = {},
) {
  const rows = await listTransactionsForGrid(pool);
  const periodFrom = asDate(opts.periodFrom);
  const periodTo = asDate(opts.periodTo);
  const checkDate = asDate(opts.checkDate);
  const includes = (value: string | null | undefined, needle: string | undefined) =>
    !needle?.trim() || (value ?? "").toLocaleLowerCase().includes(needle.trim().toLocaleLowerCase());

  return rows.filter((row) => {
    const rowStart = row.periodBegin ?? row.periodEnd;
    const rowEnd = row.periodEnd ?? row.periodBegin;
    if (periodFrom && (!rowEnd || rowEnd < periodFrom)) return false;
    if (periodTo && (!rowStart || rowStart > periodTo)) return false;
    if (checkDate && row.checkDate !== checkDate) return false;
    if (!includes(row.checkNumber, opts.checkNumber)) return false;
    if (!includes(row.employee, opts.employee)) return false;
    if (!includes(row.individual, opts.individual)) return false;
    if (!includes(`${row.programCode ?? ""} ${row.program ?? ""}`, opts.program)) return false;
    if (opts.recipient?.trim() && row.paymentRecipient !== opts.recipient) return false;
    return true;
  });
}

export async function individualPutAwayReport(
  pool: PgLikePool,
  opts: { month?: string; individual?: string; status?: string } = {},
) {
  const requestedMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month ?? "")
    ? opts.month!
    : agencyMonth();
  // Reports are manager-only, and managers/admins are full-access roles. Reuse
  // the canonical Money-operations read model instead of duplicating its
  // settlement and correction accounting here.
  const workspace = await getCollectionsWorkspace(
    pool,
    fullAccess("reports", "manager"),
    requestedMonth,
  );
  const individual = opts.individual?.trim().toLocaleLowerCase();
  return {
    month: workspace.month,
    setupHistoryAvailable: workspace.setupHistoryAvailable,
    rows: workspace.individualSetAsides
      .filter((row) => {
        if (individual && !row.individualName.toLocaleLowerCase().includes(individual)) return false;
        if (opts.status === "outstanding" && !dec(row.remainingSetAside).gt(0)) return false;
        if (
          opts.status === "missing-renewal"
          && workspace.setupHistoryAvailable
          && row.missingRenewalPlans === 0
        ) return false;
        if (opts.status === "complete" && !dec(row.remainingSetAside).eq(0)) return false;
        return true;
      })
      .map((row) => ({
        ...row,
        approvedMonthlyPlan: workspace.setupHistoryAvailable ? row.approvedMonthlyPlan : null,
        activePlans: workspace.setupHistoryAvailable ? row.activePlans : null,
        missingRenewalPlans: workspace.setupHistoryAvailable ? row.missingRenewalPlans : null,
      })),
  };
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

const PERIOD_TYPES = new Set(["calendar", "rolling", "custom"]);
const asPeriodType = (v: string | undefined): string | undefined =>
  v && PERIOD_TYPES.has(v) ? v : undefined;

function isOperationalAuthorization(row: ProgramBudgetRecord): boolean {
  return row.requiredAuthType === "hours" || row.requiredAuthType === "both";
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`))
      / 86_400_000,
  );
}

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
 * Per individual + program from the same current-authorization selector used
 * by Scheduling, People, and the owner overview. Strategy-backed compatibility
 * rows are already reduced to one primary source before these totals are made.
 */
export async function budgetUtilizationReport(
  pool: PgLikePool,
  opts: { periodType?: string; asOf?: string } = {},
): Promise<BudgetUtilizationRow[]> {
  const periodType = asPeriodType(opts.periodType) ?? null;
  const rows = await listCurrentProgramBudgets(pool, { asOf: opts.asOf ?? agencyDate() });
  return rows
    .filter((row) => (
      (row.requiredAuthType === "hours" || row.requiredAuthType === "both")
      && (periodType === null || row.periodType === periodType)
    ))
    .map((row) => {
      const authorized = dec(row.authorizedHours);
      const used = dec(row.consumedHours);
      const committed = used.plus(row.scheduledHours);
      return {
        authorizationId: row.authorizationId,
        individualId: row.individualId,
        individualName: row.individualName,
        programId: row.programId,
        programCode: row.programCode,
        programName: row.programName,
        budgetPeriodId: row.budgetPeriodId,
        periodLabel: row.periodLabel,
        periodType: row.periodType,
        startDate: row.startDate,
        endDate: row.endDate,
        authorizedHours: row.authorizedHours,
        usedHours: row.consumedHours,
        scheduledHours: row.scheduledHours,
        remainingHours: row.remainingHours,
        remainingAfterScheduledHours: row.remainingAfterScheduledHours,
        percentUsed: authorized.gt(0)
          ? used.dividedBy(authorized).times(100).toDecimalPlaces(4).toFixed(4)
          : null,
        percentCommitted: authorized.gt(0)
          ? committed.dividedBy(authorized).times(100).toDecimalPlaces(4).toFixed(4)
          : null,
      };
    });
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
 * on the canonical service date; a null filter means every transaction.
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
     WHERE ($1::date IS NULL OR canonical_service_date(
              t.period_begin, t.check_date, t.period_end
            ) >= $1)
       AND ($2::date IS NULL OR canonical_service_date(
              t.period_begin, t.check_date, t.period_end
            ) <= $2)
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
 * Per employee: total employee payment, split three ways by the canonical route
 * (transaction override, then program default), plus physical hours and the
 * number of distinct complete check identities. The three recipient buckets
 * always sum to total.
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
              FILTER (WHERE effective_payment_recipient(
                t.payment_recipient, p.payment_recipient
              ) = 'employee'), 0)::text AS paid_to_employee,
            COALESCE(sum(t.employee_payment_amount)
              FILTER (WHERE effective_payment_recipient(
                t.payment_recipient, p.payment_recipient
              ) = 'excellent_staffing'), 0)::text AS payable_by_agency,
            COALESCE(sum(t.employee_payment_amount)
              FILTER (WHERE effective_payment_recipient(
                t.payment_recipient, p.payment_recipient
              ) = 'unknown'), 0)::text
                                                          AS unknown_recipient,
            COALESCE(sum(t.imported_hours), 0)::text      AS physical_hours,
            count(DISTINCT ROW(
              t.employee_id,
              COALESCE(NULLIF(btrim(t.check_number), ''), ''),
              COALESCE(t.check_date, 'infinity'::date),
              COALESCE(t.period_begin, 'infinity'::date),
              COALESCE(t.period_end, 'infinity'::date)
            )) FILTER (WHERE
              NULLIF(btrim(t.check_number), '') IS NOT NULL
              OR t.check_date IS NOT NULL
              OR t.period_begin IS NOT NULL
              OR t.period_end IS NOT NULL
            )::text                                     AS check_count
     FROM employees e
     JOIN payroll_transactions t ON t.employee_id = e.id
     LEFT JOIN programs p ON p.id = t.program_id
     WHERE ($1::date IS NULL OR canonical_service_date(
              t.period_begin, t.check_date, t.period_end
            ) >= $1)
       AND ($2::date IS NULL OR canonical_service_date(
              t.period_begin, t.check_date, t.period_end
            ) <= $2)
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
  /** Full service hours credited to every individual transaction row. */
  creditedIndividualHours: string;
  /** Employee time counted once per delivered service session. */
  physicalEmployeeHours: string;
  agencyGross: string;
  internalAmount: string;
  agencyAdditional: string;
  groupSessions: number;
}

/**
 * Per program: people served, employees, credited individual hours, physical
 * employee hours, money, and group sessions.
 *
 * Group services deliberately produce two different hour totals. Every member
 * receives the full hours as a budget credit, while the employee only worked
 * the session once. Transaction rows are the committed activity ledger;
 * service_sessions are consulted only to count that physical time once.
 */
export async function programTotalsReport(
  pool: PgLikePool,
  opts: { from?: string; to?: string } = {},
): Promise<ProgramTotalsRow[]> {
  const from = asDate(opts.from) ?? null;
  const to = asDate(opts.to) ?? null;
  const { rows } = await pool.query<{
    program_id: string;
    program_code: string;
    program_name: string;
    individuals_served: string;
    employees: string;
    credited_individual_hours: string;
    physical_employee_hours: string;
    agency_gross: string;
    internal_amount: string;
    agency_additional: string;
    group_sessions: string;
  }>(
    `WITH activity AS (
       SELECT t.*
         FROM payroll_transactions t
        WHERE ($1::date IS NULL OR canonical_service_date(
                 t.period_begin, t.check_date, t.period_end
               ) >= $1)
          AND ($2::date IS NULL OR canonical_service_date(
                 t.period_begin, t.check_date, t.period_end
               ) <= $2)
     ),
     transaction_totals AS (
       SELECT t.program_id,
              count(DISTINCT t.individual_id) AS individuals_served,
              count(DISTINCT t.employee_id) AS employees,
              COALESCE(sum(t.imported_hours), 0) AS credited_individual_hours,
              COALESCE(sum(t.imported_amount), 0) AS agency_gross,
              COALESCE(sum(t.calculated_internal_amount), 0) AS internal_amount,
              COALESCE(sum(t.agency_additional_amount), 0) AS agency_additional
         FROM activity t
        GROUP BY t.program_id
     ),
     physical_sessions AS (
       SELECT t.program_id,
              COALESCE(
                'session:' || t.service_session_id::text,
                'transaction:' || t.id::text
              ) AS activity_key,
              max(COALESCE(ss.physical_hours, t.imported_hours, 0)) AS physical_hours,
              bool_or(COALESCE(ss.group_size > 1, false) OR t.is_group_service) AS is_group
         FROM activity t
         LEFT JOIN service_sessions ss ON ss.id = t.service_session_id
        GROUP BY t.program_id,
                 COALESCE(
                   'session:' || t.service_session_id::text,
                   'transaction:' || t.id::text
                 )
     ),
     physical_totals AS (
       SELECT program_id,
              COALESCE(sum(physical_hours), 0) AS physical_employee_hours,
              count(*) FILTER (WHERE is_group) AS group_sessions
         FROM physical_sessions
        GROUP BY program_id
     )
     SELECT p.id                                                    AS program_id,
            p.code                                                  AS program_code,
            p.name                                                  AS program_name,
            COALESCE(tx.individuals_served, 0)::text                AS individuals_served,
            COALESCE(tx.employees, 0)::text                         AS employees,
            COALESCE(tx.credited_individual_hours, 0)::text         AS credited_individual_hours,
            COALESCE(physical.physical_employee_hours, 0)::text     AS physical_employee_hours,
            COALESCE(tx.agency_gross, 0)::text                      AS agency_gross,
            COALESCE(tx.internal_amount, 0)::text                   AS internal_amount,
            COALESCE(tx.agency_additional, 0)::text                 AS agency_additional,
            COALESCE(physical.group_sessions, 0)::text              AS group_sessions
       FROM programs p
       LEFT JOIN transaction_totals tx ON tx.program_id = p.id
       LEFT JOIN physical_totals physical ON physical.program_id = p.id
      ORDER BY p.code`,
    [from, to],
  );
  return rows.map((r) => ({
    programId: r.program_id,
    programCode: r.program_code,
    programName: r.program_name,
    individualsServed: Number(r.individuals_served),
    employees: Number(r.employees),
    creditedIndividualHours: toHours(r.credited_individual_hours),
    physicalEmployeeHours: toHours(r.physical_employee_hours),
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
 * Current authorizations whose period end or renewal falls within the next N
 * days (default 60). The shared selector includes one non-duplicated financial
 * plan fallback when an explicit service authorization has not been created.
 */
export async function expiringAuthorizationsReport(
  pool: PgLikePool,
  opts: { withinDays?: number; asOf?: string } = {},
): Promise<ExpiringAuthorizationRow[]> {
  const withinDays = opts.withinDays && opts.withinDays > 0 ? Math.min(opts.withinDays, 3650) : 60;
  const today = asDate(opts.asOf) ?? agencyDate();
  const budgets = await listCurrentProgramBudgets(pool, { asOf: today });
  return budgets.flatMap((row) => {
    const upcoming = [row.endDate, row.renewalDate]
      .filter((date): date is string => Boolean(date && date >= today))
      .map((date) => daysBetween(today, date))
      .filter((days) => days <= withinDays)
      .sort((left, right) => left - right);
    if (upcoming.length === 0) return [];
    return [{
      authorizationId: row.authorizationId,
      individualId: row.individualId,
      individualName: row.individualName,
      programCode: row.programCode,
      programName: row.programName,
      periodLabel: row.periodLabel,
      endDate: row.endDate,
      renewalDate: row.renewalDate,
      daysRemaining: upcoming[0]!,
      authorizedHours: row.authorizedHours,
      usedHours: row.consumedHours,
    }];
  }).sort((left, right) => (
    left.daysRemaining - right.daysRemaining
      || left.individualName.localeCompare(right.individualName)
      || left.programCode.localeCompare(right.programCode)
  ));
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

export async function missingRatesReport(pool: PgLikePool): Promise<MissingRateRow[]> {
  const { rows } = await pool.query<{
    program_id: string;
    program_code: string;
    program_name: string;
  }>(
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
  );
  return rows.map((row) => ({
    programId: row.program_id,
    programCode: row.program_code,
    programName: row.program_name,
  }));
}

async function missingAssignmentRows(
  pool: PgLikePool,
  budgets: ProgramBudgetRecord[],
): Promise<MissingAssignmentRow[]> {
  const authorized = new Map<string, Set<string>>();
  for (const row of budgets.filter(isOperationalAuthorization)) {
    const current = authorized.get(row.individualId);
    if (current) current.add(row.programCode);
    else authorized.set(row.individualId, new Set([row.programCode]));
  }
  const individualIds = [...authorized.keys()];
  if (individualIds.length === 0) return [];

  const { rows } = await pool.query<{
    individual_id: string;
    individual_name: string;
    has_assignment: boolean;
  }>(
    `SELECT i.id AS individual_id, i.display_name AS individual_name,
            EXISTS (
              SELECT 1 FROM assignments assignment
               WHERE assignment.individual_id = i.id
                 AND assignment.status = 'active'
            ) AS has_assignment
       FROM individuals i
      WHERE i.status = 'active'
        AND i.archived_at IS NULL
        AND i.merged_into_id IS NULL
        AND i.id = ANY($1::uuid[])
      ORDER BY i.display_name`,
    [individualIds],
  );
  return rows.filter((row) => !row.has_assignment).map((row) => ({
    individualId: row.individual_id,
    individualName: row.individual_name,
    programsAuthorized: [...(authorized.get(row.individual_id) ?? [])]
      .sort()
      .join(", ") || null,
  }));
}

export async function missingConfigurationReport(
  pool: PgLikePool,
): Promise<MissingAssignmentRow[]> {
  const budgets = await listCurrentProgramBudgets(pool, { asOf: agencyDate() });
  return missingAssignmentRows(pool, budgets);
}

/**
 * Two gaps that quietly break downstream figures:
 *   - active programs with no rate schedule in force today, and
 *   - active individuals with an active authorization but no active assignment.
 */
export async function missingConfigReport(pool: PgLikePool): Promise<MissingConfigReport> {
  const [missingRates, budgets] = await Promise.all([
    missingRatesReport(pool),
    listCurrentProgramBudgets(pool, { asOf: agencyDate() }),
  ]);
  const missingAssignments = await missingAssignmentRows(pool, budgets);
  return {
    missingRates,
    missingAssignments,
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
 * The extra figures the redesigned dashboard tiles need. Money is summed in
 * SQL and returned as text. "available" is false when there
 * ARE transactions but none carry the figure, so the tile can say why rather
 * than print a misleading $0.
 */
export async function dashboardReportMetrics(pool: PgLikePool): Promise<DashboardReportMetrics> {
  const today = agencyDate();
  const budgets = await listCurrentProgramBudgets(pool, { asOf: today });
  const [metricResult, missingRates, missingAssignments] = await Promise.all([
    pool.query<{
      agency_additional: string;
      agency_additional_rows: string;
      employee_payable: string;
      employee_payable_rows: string;
      transaction_rows: string;
      unbilled_schedules: string;
      unscheduled_billing: string;
    }>(
      `SELECT
       (SELECT COALESCE(sum(agency_additional_amount), 0) FROM payroll_transactions)::text AS agency_additional,
       (SELECT count(*) FROM payroll_transactions WHERE agency_additional_amount IS NOT NULL)::text AS agency_additional_rows,
       (SELECT COALESCE(sum(employee_payment_amount), 0) FROM payroll_transactions)::text AS employee_payable,
       (SELECT count(*) FROM payroll_transactions WHERE employee_payment_amount IS NOT NULL)::text AS employee_payable_rows,
       (SELECT count(*) FROM payroll_transactions)::text                                AS transaction_rows,
       (SELECT count(*) FROM scheduled_sessions
         WHERE status = 'pending' AND matched_transaction_id IS NULL)::text             AS unbilled_schedules,
       (SELECT count(*) FROM payroll_transactions t
          WHERE NOT EXISTS (SELECT 1 FROM scheduled_sessions s WHERE s.matched_transaction_id = t.id))::text
                                                                                         AS unscheduled_billing`,
    ),
    missingRatesReport(pool),
    missingAssignmentRows(pool, budgets),
  ]);
  const r = metricResult.rows[0]!;
  const txRows = Number(r.transaction_rows ?? 0);
  const operational = budgets.filter(isOperationalAuthorization);
  const nearExhaustion = operational.filter((row) => {
    const authorized = dec(row.authorizedHours);
    return authorized.gt(0)
      && dec(row.consumedHours).plus(row.scheduledHours).gte(authorized.times(0.9));
  }).length;
  const underutilizing = operational.filter((row) => {
    const authorized = dec(row.authorizedHours);
    const periodDays = daysBetween(row.startDate, row.endDate);
    return authorized.gt(0)
      && periodDays > 0
      && daysBetween(row.startDate, today) / periodDays >= 0.5
      && dec(row.consumedHours).plus(row.scheduledHours).lt(authorized.times(0.5));
  }).length;
  const expiringAuthorizations = budgets.filter((row) => (
    [row.endDate, row.renewalDate].some((date) => {
      if (!date || date < today) return false;
      return daysBetween(today, date) <= 60;
    })
  )).length;
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
      nearExhaustion,
      underutilizing,
      expiringAuthorizations,
      unbilledSchedules: Number(r.unbilled_schedules ?? 0),
      unscheduledBilling: Number(r.unscheduled_billing ?? 0),
      missingRates: missingRates.length,
      missingAssignments: missingAssignments.length,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 7. Cuts & monthly calculation                                              */
/* -------------------------------------------------------------------------- */

export interface CutsMonthlyRow {
  strategyId: string;
  individualId: string;
  individualName: string;
  setupName: string;
  programCode: string | null;
  programName: string | null;
  annualGross: string;
  monthlyGross: string;
  cut1Amount: string;
  cut2Amount: string;
  clockAdjustment: string;
  otherAdjustment: string;
  calculatedNet: string;
  approvedFinal: string | null;
  /** Approved monthly final minus the step-by-step calculated net. */
  difference: string | null;
}

/**
 * One row per active Financial setup strategy. This deliberately reads the
 * same canonical plans as the Financial setup workspace; the legacy
 * budget_calculations import is not a second source of financial truth.
 */
export async function cutsMonthlyReport(
  pool: PgLikePool,
  opts: { program?: string } = {},
): Promise<CutsMonthlyRow[]> {
  const filter = (opts.program ?? "").trim().toLocaleLowerCase();
  const { rows, programs } = await listStrategies(pool);
  const programsById = new Map(programs.map((item) => [item.id, item]));
  const fraction = (value: string) => {
    const parsed = dec(value || 0).abs();
    return parsed.greaterThan(1) ? parsed.dividedBy(100) : parsed;
  };

  return rows.flatMap((row) => {
    const selectedPrograms = Object.entries(row.hours)
      .filter(([, hours]) => !dec(hours).isZero())
      .map(([programId]) => programsById.get(programId))
      .filter((program): program is NonNullable<typeof program> => Boolean(program));
    if (
      filter &&
      !selectedPrograms.some((program) =>
        `${program.code} ${program.name}`.toLocaleLowerCase().includes(filter),
      )
    ) {
      return [];
    }

    const monthly = dec(row.monthlyGross);
    const cut1Amount = monthly.times(fraction(row.cut1Percent));
    const cut2Amount = monthly.minus(cut1Amount).times(fraction(row.cut2Percent));
    const approved = row.afterAll == null ? null : toMoney(row.afterAll);
    return [{
      strategyId: row.id,
      individualId: row.individualId,
      individualName: row.individualName,
      setupName: row.label,
      programCode: selectedPrograms.map((program) => program.code).join(", ") || null,
      programName: selectedPrograms.map((program) => program.name).join(", ") || null,
      annualGross: toMoney(row.yearlyGross),
      monthlyGross: toMoney(row.monthlyGross),
      cut1Amount: toMoney(cut1Amount),
      cut2Amount: toMoney(cut2Amount),
      clockAdjustment: toMoney(row.clockAdjustment),
      otherAdjustment: toMoney(row.otherAdjustment),
      calculatedNet: toMoney(row.net),
      approvedFinal: approved,
      difference: approved == null ? null : toMoney(dec(approved).minus(row.net)),
    }];
  });
}

/* -------------------------------------------------------------------------- */
/* 8. Alias decisions                                                         */
/* -------------------------------------------------------------------------- */

export interface AliasDecisionRow {
  sourceText: string;
  normalizedAlias: string;
  canonicalId: string;
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
  opts: { kind?: string; status?: string; from?: string; to?: string } = {},
): Promise<AliasDecisionRow[]> {
  const kind = opts.kind === "individual" || opts.kind === "employee" ? opts.kind : null;
  const status = opts.status === "pending" || opts.status === "approved" ? opts.status : null;
  const from = asDate(opts.from) ?? null;
  const to = asDate(opts.to) ?? null;
  const { rows } = await pool.query<{
    source_text: string;
    normalized_alias: string;
    canonical_id: string;
    canonical_name: string;
    kind: string;
    status: string;
    approved_by: string | null;
    created_at: string;
  }>(
    `SELECT x.source_text, x.normalized_alias, x.canonical_id, x.canonical_name,
            x.kind, x.status, x.approved_by, x.created_at::date::text AS created_at
     FROM (
       SELECT ia.source_text, ia.normalized_alias, i.id AS canonical_id,
              i.display_name AS canonical_name,
              'individual'::text AS kind, ia.status,
              u.display_name AS approved_by, ia.created_at
       FROM individual_aliases ia
       JOIN individuals i ON i.id = ia.individual_id
       LEFT JOIN users u ON u.id = ia.approved_by_user_id
       UNION ALL
       SELECT ea.source_text, ea.normalized_alias, e.id,
              e.display_name,
              'employee'::text, ea.status,
              u.display_name, ea.created_at
       FROM employee_aliases ea
       JOIN employees e ON e.id = ea.employee_id
       LEFT JOIN users u ON u.id = ea.approved_by_user_id
     ) x
     WHERE ($1::text IS NULL OR x.kind = $1)
       AND ($2::text IS NULL OR x.status = $2)
       AND ($3::date IS NULL OR x.created_at::date >= $3)
       AND ($4::date IS NULL OR x.created_at::date <= $4)
     ORDER BY x.kind, x.canonical_name, x.source_text`,
    [kind, status, from, to],
  );
  return rows.map((r) => ({
    sourceText: r.source_text,
    normalizedAlias: r.normalized_alias,
    canonicalId: r.canonical_id,
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
  entityId: string | null;
  reason: string | null;
  sourceHref: string | null;
}

function auditSourceHref(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  if (entityType === "individual") return `/individuals/${encodeURIComponent(entityId)}`;
  if (entityType === "employee") return `/employees/${encodeURIComponent(entityId)}`;
  if (entityType === "payroll_transaction") return txLink({ transactionId: entityId });
  if (entityType === "program") return "/settings#programs";
  if (entityType === "calculation_strategy") return "/calculations";
  if (entityType.startsWith("class_")) return "/classes";
  if (entityType === "document") {
    return `/documents/pdf-editor?id=${encodeURIComponent(entityId)}`;
  }
  return null;
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
    entity_id: string | null;
    reason: string | null;
  }>(
    `SELECT to_char(a.created_at, 'YYYY-MM-DD HH24:MI') AS ts,
            u.display_name                              AS actor,
            a.action                                    AS action,
            a.entity_type                               AS entity_type,
            a.entity_id::text                           AS entity_id,
            a.reason                                    AS reason
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
    entityId: r.entity_id,
    reason: r.reason,
    sourceHref: auditSourceHref(r.entity_type, r.entity_id),
  }));
}

/* -------------------------------------------------------------------------- */
/* 10. Group activity                                                         */
/* -------------------------------------------------------------------------- */

export interface GroupServiceRow {
  serviceSessionId: string;
  programId: string | null;
  programCode: string | null;
  programName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  groupSize: number;
  memberCount: number;
  combinedAmount: string | null;
  detectionStatus: string;
  transactionIds: string[];
}
export interface ScheduledGroupCountRow {
  programId: string | null;
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
    program_id: string | null;
    program_code: string | null;
    program_name: string | null;
    employee_id: string | null;
    employee_name: string | null;
    period_begin: string | null;
    period_end: string | null;
    group_size: number;
    member_count: string;
    combined_amount: string | null;
    group_detection_status: string;
    transaction_ids: string[] | null;
  }>(
    `SELECT ss.id                       AS service_session_id,
            p.id                         AS program_id,
            p.code                       AS program_code,
            p.name                       AS program_name,
            e.id                         AS employee_id,
            e.display_name               AS employee_name,
            ss.period_begin::text        AS period_begin,
            ss.period_end::text          AS period_end,
            ss.group_size                AS group_size,
            (SELECT count(*) FROM service_allocations sa
              WHERE sa.service_session_id = ss.id)::text AS member_count,
            ss.combined_amount::text     AS combined_amount,
            ss.group_detection_status    AS group_detection_status,
            ARRAY(
              SELECT sa.payroll_transaction_id::text
                FROM service_allocations sa
               WHERE sa.service_session_id = ss.id
                 AND sa.payroll_transaction_id IS NOT NULL
               ORDER BY sa.payroll_transaction_id
            ) AS transaction_ids
     FROM service_sessions ss
     LEFT JOIN programs p  ON p.id = ss.program_id
     LEFT JOIN employees e ON e.id = ss.employee_id
     LEFT JOIN LATERAL (
       SELECT min(canonical_service_date(
                source_t.period_begin, source_t.check_date, source_t.period_end
              )) AS service_date
         FROM service_allocations source_a
         JOIN payroll_transactions source_t ON source_t.id = source_a.payroll_transaction_id
        WHERE source_a.service_session_id = ss.id
     ) source_date ON true
     WHERE ss.group_size > 1
       AND ($1::date IS NULL OR COALESCE(
              canonical_service_date(ss.period_begin, NULL, ss.period_end),
              source_date.service_date
            ) >= $1)
       AND ($2::date IS NULL OR COALESCE(
              canonical_service_date(ss.period_begin, NULL, ss.period_end),
              source_date.service_date
            ) <= $2)
       AND ($3::text IS NULL OR p.code ILIKE '%' || $3 || '%' OR p.name ILIKE '%' || $3 || '%')
     ORDER BY COALESCE(
                canonical_service_date(ss.period_begin, NULL, ss.period_end),
                source_date.service_date
              ) NULLS LAST,
              p.code`,
    [from, to, program],
  );

  const countsRes = await pool.query<{
    program_id: string | null;
    program_code: string | null;
    program_name: string | null;
    session_count: string;
  }>(
    `SELECT p.id AS program_id, p.code AS program_code, p.name AS program_name,
            count(*)::text AS session_count
     FROM scheduled_sessions s
     LEFT JOIN programs p ON p.id = s.program_id
     WHERE (s.is_group = true OR s.group_size > 1)
       AND s.status IN ('pending', 'completed')
       AND ($1::date IS NULL OR s.session_date >= $1)
       AND ($2::date IS NULL OR s.session_date <= $2)
       AND ($3::text IS NULL OR p.code ILIKE '%' || $3 || '%' OR p.name ILIKE '%' || $3 || '%')
     GROUP BY p.id, p.code, p.name
     ORDER BY p.code NULLS LAST`,
    [from, to, program],
  );

  return {
    sessions: sessionsRes.rows.map((r) => ({
      serviceSessionId: r.service_session_id,
      programId: r.program_id,
      programCode: r.program_code,
      programName: r.program_name,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      periodBegin: r.period_begin,
      periodEnd: r.period_end,
      groupSize: Number(r.group_size),
      memberCount: Number(r.member_count),
      combinedAmount: r.combined_amount === null ? null : toMoney(r.combined_amount),
      detectionStatus: r.group_detection_status,
      transactionIds: r.transaction_ids ?? [],
    })),
    scheduledCounts: countsRes.rows.map((r) => ({
      programId: r.program_id,
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
  programId: string | null;
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
 * and internal from the committed payroll transaction ledger. Reconciliation
 * allocations are intentionally not an actuals source. A UNION of the two key
 * sets means a pair that is only scheduled, or only actual, still appears with
 * real zeros on the missing side.
 */
export async function actualVsScheduledReport(
  pool: PgLikePool,
  opts: {
    from?: string;
    to?: string;
    individual?: string;
    employee?: string;
    program?: string;
  } = {},
): Promise<ActualVsScheduledRow[]> {
  const from = asDate(opts.from) ?? null;
  const to = asDate(opts.to) ?? null;
  const individual = (opts.individual ?? "").trim() || null;
  const employee = (opts.employee ?? "").trim() || null;
  const program = (opts.program ?? "").trim() || null;
  const { rows } = await pool.query<{
    individual_id: string;
    individual_name: string;
    program_id: string | null;
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
       JOIN individuals sched_individual ON sched_individual.id = sa.individual_id
       LEFT JOIN employees sched_employee ON sched_employee.id = s.employee_id
       LEFT JOIN programs sched_program ON sched_program.id = s.program_id
       WHERE s.status IN ('pending', 'completed')
         AND ($1::date IS NULL OR s.session_date >= $1)
         AND ($2::date IS NULL OR s.session_date <= $2)
         AND ($3::text IS NULL OR sa.individual_id::text = $3
              OR sched_individual.display_name ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR s.employee_id::text = $4
              OR sched_employee.display_name ILIKE '%' || $4 || '%')
         AND ($5::text IS NULL OR sched_program.code ILIKE '%' || $5 || '%'
              OR sched_program.name ILIKE '%' || $5 || '%')
       GROUP BY sa.individual_id, s.program_id
     ),
     actual AS (
       SELECT t.individual_id, t.program_id,
              COALESCE(sum(t.imported_hours), 0) AS hours,
              COALESCE(sum(t.calculated_internal_amount), 0) AS internal
       FROM payroll_transactions t
       JOIN individuals actual_individual ON actual_individual.id = t.individual_id
       LEFT JOIN employees actual_employee ON actual_employee.id = t.employee_id
       LEFT JOIN programs actual_program ON actual_program.id = t.program_id
       WHERE t.individual_id IS NOT NULL
         AND ($1::date IS NULL OR canonical_service_date(
                t.period_begin, t.check_date, t.period_end
              ) >= $1)
         AND ($2::date IS NULL OR canonical_service_date(
                t.period_begin, t.check_date, t.period_end
              ) <= $2)
         AND ($3::text IS NULL OR t.individual_id::text = $3
              OR actual_individual.display_name ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR t.employee_id::text = $4
              OR actual_employee.display_name ILIKE '%' || $4 || '%')
         AND ($5::text IS NULL OR actual_program.code ILIKE '%' || $5 || '%'
              OR actual_program.name ILIKE '%' || $5 || '%')
       GROUP BY t.individual_id, t.program_id
     ),
     keys AS (
       SELECT individual_id, program_id FROM sched
       UNION
       SELECT individual_id, program_id FROM actual
     )
     SELECT k.individual_id                                    AS individual_id,
            i.display_name                                     AS individual_name,
            k.program_id                                       AS program_id,
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
     ORDER BY i.display_name, p.code NULLS FIRST`,
    [from, to, individual, employee, program],
  );
  return rows.map((r) => ({
    individualId: r.individual_id,
    individualName: r.individual_name,
    programId: r.program_id,
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
 * half the period has elapsed). Used hours come from the shared current
 * authorization selector, like the utilization report. Filterable by flag and
 * program; only outliers appear.
 */
export async function utilizationOutliersReport(
  pool: PgLikePool,
  opts: { flag?: string; program?: string; asOf?: string } = {},
): Promise<UtilizationOutlierRow[]> {
  const flag =
    opts.flag === "underutilizing" || opts.flag === "overutilizing" ? opts.flag : null;
  const program = (opts.program ?? "").trim() || null;
  const today = asDate(opts.asOf) ?? agencyDate();
  const rows = await listCurrentProgramBudgets(pool, { asOf: today });
  return rows.flatMap((row) => {
    if (!isOperationalAuthorization(row)) return [];
    const haystack = `${row.programCode} ${row.programName}`.toLocaleLowerCase();
    if (program && !haystack.includes(program.toLocaleLowerCase())) return [];
    const authorized = dec(row.authorizedHours);
    const used = dec(row.consumedHours);
    const periodDays = daysBetween(row.startDate, row.endDate);
    const rowFlag = authorized.gt(0) && used.gt(authorized)
      ? "overutilizing"
      : authorized.gt(0)
        && used.lt(authorized.times(0.5))
        && periodDays > 0
        && daysBetween(row.startDate, today) / periodDays > 0.5
          ? "underutilizing"
          : null;
    if (!rowFlag || (flag && rowFlag !== flag)) return [];
    return [{
      authorizationId: row.authorizationId,
      individualId: row.individualId,
      individualName: row.individualName,
      programCode: row.programCode,
      programName: row.programName,
      periodLabel: row.periodLabel,
      authorizedHours: row.authorizedHours,
      usedHours: row.consumedHours,
      remainingHours: row.remainingHours,
      percentUsed: authorized.gt(0)
        ? used.dividedBy(authorized).times(100).toDecimalPlaces(4).toFixed(4)
        : null,
      flag: rowFlag,
    }];
  }).sort((left, right) => (
    left.flag.localeCompare(right.flag)
      || left.individualName.localeCompare(right.individualName)
      || left.programCode.localeCompare(right.programCode)
  ));
}

/* -------------------------------------------------------------------------- */
/* Report registry: one definition drives the page table AND the export       */
/* -------------------------------------------------------------------------- */

const DATE_FILTERS: ReportFilterSpec[] = [
  { key: "from", label: "From", type: "date" },
  { key: "to", label: "To", type: "date" },
];

const sourceColumn = (
  header = "Source",
  linkLabel = "Open source",
): ReportColumn => ({ key: "sourceHref", header, type: "text", linkLabel });

function transactionTableSource(
  filters: Record<string, string | undefined>,
  label = "Open the filtered Transactions ledger",
): ReportTable["source"] {
  const exactCheckDate = asDate(filters.checkDate);
  return {
    href: txLink({
      checkNumber: filters.checkNumber,
      program: filters.program,
      pbFrom: asDate(filters.periodFrom),
      pbTo: asDate(filters.periodTo),
      from: exactCheckDate,
      to: exactCheckDate,
      serviceFrom: asDate(filters.from),
      serviceTo: asDate(filters.to),
    }),
    label,
  };
}

const MONEY_OPERATION_FILTERS: ReportFilterSpec[] = [
  ...DATE_FILTERS,
  { key: "person", label: "Person", type: "text", placeholder: "Name" },
  {
    key: "state",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "All statuses" },
      { value: "open", label: "Open" },
      { value: "partial", label: "Partial" },
      { value: "settled", label: "Settled" },
      { value: "credit", label: "Credit" },
      { value: "void", label: "Void" },
    ],
  },
];

function moneyOperationTable(
  key: "give-back" | "agency-to-employee-payments" | "credits",
  queue: "receivable" | "payable" | "credit",
  rows: Awaited<ReturnType<typeof moneyOperationsReport>>,
): ReportTable {
  return {
    key,
    emptyMessage: "No Money operations items match this scope.",
    source: {
      href: `/settlements?queue=${queue}`,
      label: "Open the matching Money operations queue",
    },
    columns: [
      { key: "basisDate", header: "Basis date", type: "date" },
      { key: "personName", header: "Person", type: "text" },
      { key: "item", header: "Item", type: "text" },
      { key: "checkNumber", header: "Check number", type: "text" },
      { key: "originalAmount", header: "Original amount", type: "money" },
      { key: "recordedAmount", header: "Recorded activity", type: "money" },
      { key: "balance", header: "Remaining balance", type: "money" },
      { key: "state", header: "Status", type: "text" },
      sourceColumn("Money source", "Open item"),
    ],
    rows: rows.map((row) => ({
      basisDate: row.basisDate,
      personName: row.personName,
      employeeId: row.personType === "employee" ? row.personId : null,
      individualId: row.personType === "individual" ? row.personId : null,
      item: row.item,
      checkNumber: row.checkNumber,
      originalAmount: row.originalAmount,
      recordedAmount: row.recordedAmount,
      balance: row.balance,
      state: row.state,
      sourceHref: row.sourceHref,
    })),
  };
}

export const REPORTS: Record<string, ReportDefinition> = {
  "payroll-checks": {
    key: "payroll-checks",
    title: "Payroll checks",
    description:
      "Committed payroll transaction rows with check identity, people, program, recipient, hours, Funder billed, and Employee base kept traceable to the source ledger.",
    filters: [
      { key: "periodFrom", label: "Payroll period from", type: "date" },
      { key: "periodTo", label: "Payroll period through", type: "date" },
      { key: "checkDate", label: "Check date", type: "date" },
      { key: "checkNumber", label: "Check number", type: "text", placeholder: "Number" },
      { key: "employee", label: "Employee", type: "text", placeholder: "Name" },
      { key: "individual", label: "Individual", type: "text", placeholder: "Name" },
      { key: "program", label: "Program", type: "text", placeholder: "Code or name" },
      {
        key: "recipient",
        label: "Recipient",
        type: "select",
        options: [
          { value: "", label: "All recipients" },
          { value: "employee", label: "Employee" },
          { value: "excellent_staffing", label: "Excellent Staffing" },
          { value: "unknown", label: "Unresolved" },
        ],
      },
    ],
    async run(pool, filters) {
      const rows = await payrollChecksReport(pool, filters);
      return [{
        key: "payroll-checks",
        emptyMessage: "No committed payroll transactions match this scope.",
        source: transactionTableSource(filters),
        columns: [
          { key: "checkDate", header: "Check date", type: "date" },
          { key: "checkNumber", header: "Check number", type: "text" },
          { key: "periodBegin", header: "Period begin", type: "date" },
          { key: "periodEnd", header: "Period end", type: "date" },
          { key: "employeeName", header: "Employee", type: "text" },
          { key: "individualName", header: "Individual", type: "text" },
          { key: "programName", header: "Program", type: "text" },
          { key: "paymentRecipient", header: "Recipient", type: "text" },
          { key: "hours", header: "Hours", type: "hours" },
          { key: "funderBilled", header: "Funder billed", type: "money" },
          { key: "employeeBase", header: "Employee base", type: "money" },
          { key: "agencySpread", header: "Agency spread", type: "money" },
          { key: "checkNet", header: "Check net (repeated)", type: "money" },
          { key: "paidStatus", header: "Paid status", type: "text" },
          sourceColumn("Ledger source", "Open transaction"),
        ],
        rows: rows.map((row) => ({
          checkDate: row.checkDate,
          checkNumber: row.checkNumber,
          periodBegin: row.periodBegin,
          periodEnd: row.periodEnd,
          employeeName: row.employee,
          employeeId: row.employeeId,
          individualName: row.individual,
          individualId: row.individualId,
          programName: row.programCode
            ? `${row.programCode} — ${row.program ?? ""}`.replace(/ — $/, "")
            : row.program,
          paymentRecipient: row.paymentRecipient === "excellent_staffing"
            ? "Excellent Staffing"
            : row.paymentRecipient === "employee"
              ? "Employee"
              : "Unresolved",
          hours: row.hours,
          funderBilled: row.gross,
          employeeBase: row.internalAmount,
          agencySpread: row.agencyAdditional,
          checkNet: row.totalNetPay == null ? null : toMoney(row.totalNetPay),
          gross: row.gross,
          internalAmount: row.internalAmount,
          agencyAdditional: row.agencyAdditional,
          totalNetPay: row.totalNetPay,
          payTo: row.payTo,
          employee: row.employee,
          individual: row.individual,
          paidStatus: row.isPaid ? "Paid" : "Not paid",
          transactionId: row.id,
          sourceHref: transactionSourceHref(row),
        })),
      }];
    },
  },

  "give-back": {
    key: "give-back",
    title: "Give-Back",
    description:
      "Employee receivables from the canonical Money operations ledger, including recorded activity and remaining balance.",
    filters: MONEY_OPERATION_FILTERS,
    async run(pool, filters) {
      const rows = await moneyOperationsReport(pool, "give-back", filters);
      return [moneyOperationTable("give-back", "receivable", rows)];
    },
  },

  "agency-to-employee-payments": {
    key: "agency-to-employee-payments",
    title: "Agency-to-Employee payments",
    description:
      "Employee payables from the canonical Money operations ledger, including recorded payment activity and remaining balance.",
    filters: MONEY_OPERATION_FILTERS,
    async run(pool, filters) {
      const rows = await moneyOperationsReport(pool, "agency-to-employee", filters);
      return [moneyOperationTable("agency-to-employee-payments", "payable", rows)];
    },
  },

  credits: {
    key: "credits",
    title: "Credits",
    description:
      "Over-applied Money operations items that carry a credit balance, with the original obligation and recorded activity preserved.",
    filters: MONEY_OPERATION_FILTERS,
    async run(pool, filters) {
      const rows = await moneyOperationsReport(pool, "credits", filters);
      return [moneyOperationTable("credits", "credit", rows)];
    },
  },

  "individual-put-away": {
    key: "individual-put-away",
    title: "Individual put-away",
    description:
      "Approved monthly plans, recorded put-away activity, and remaining reserve by individual from the canonical Money-operations ledger.",
    filters: [
      { key: "month", label: "Month", type: "month", defaultValue: agencyMonth() },
      { key: "individual", label: "Individual", type: "text", placeholder: "Name" },
      {
        key: "status",
        label: "Attention",
        type: "select",
        options: [
          { value: "", label: "All" },
          { value: "outstanding", label: "Outstanding reserve" },
          { value: "missing-renewal", label: "Missing renewal date" },
          { value: "complete", label: "No remaining reserve" },
        ],
      },
    ],
    async run(pool, filters) {
      const data = await individualPutAwayReport(pool, filters);
      return [{
        key: "individual-put-away",
        title: data.setupHistoryAvailable
          ? undefined
          : "Financial Setup history is unavailable before August 2026; recorded ledger activity remains shown.",
        emptyMessage: "No individual put-away records match this month and filter.",
        source: {
          href: `/masser?month=${encodeURIComponent(data.month)}`,
          label: "Open the source Money workspace",
        },
        columns: [
          { key: "individualName", header: "Individual", type: "text" },
          { key: "approvedMonthlyPlan", header: "Approved monthly plan", type: "money" },
          { key: "setupStatus", header: "Setup history", type: "text" },
          { key: "setAsideThisMonth", header: "Put away this month", type: "money" },
          { key: "remainingSetAside", header: "Remaining reserve", type: "money" },
          { key: "activePlans", header: "Active plans", type: "int" },
          { key: "trackedPlans", header: "Tracked plans", type: "int" },
          { key: "missingRenewalPlans", header: "Missing renewals", type: "int" },
          { key: "statementSource", header: "Source statement", type: "text" },
        ],
        rows: data.rows.map((row) => ({
          individualName: row.individualName,
          individualId: row.individualId,
          approvedMonthlyPlan: row.approvedMonthlyPlan,
          setupStatus: data.setupHistoryAvailable ? "Available" : "Unavailable before Aug 2026",
          setAsideThisMonth: row.setAsideThisMonth,
          remainingSetAside: row.remainingSetAside,
          activePlans: row.activePlans,
          trackedPlans: row.trackedPlans,
          missingRenewalPlans: row.missingRenewalPlans,
          statementSource: row.individualId,
          reportMonth: data.month,
        })),
      }];
    },
  },

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
          { value: "calendar", label: "Calendar year" },
          { value: "rolling", label: "Rolling 12 month" },
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
          source: { href: "/individuals", label: "Open People & budgets" },
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
            sourceColumn("Budget source", "Open budget"),
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
            sourceHref: `/individuals/${encodeURIComponent(r.individualId)}?view=budget`,
          })),
        },
      ];
    },
  },

  "billing-without-budget": {
    key: "billing-without-budget",
    title: "Billing without budget",
    description:
      "Recorded activity whose exact Individual and Program pair lacked hours authorization on its canonical service date. A later budget or a budget for another Program does not clear the exception.",
    filters: [
      ...DATE_FILTERS,
      { key: "individual", label: "Individual", type: "text", placeholder: "Name" },
      { key: "program", label: "Program", type: "text", placeholder: "Code or name" },
    ],
    async run(pool, filters) {
      const rows = await billingWithoutBudgetReport(pool, {
        from: filters.from,
        to: filters.to,
        individual: filters.individual,
        program: filters.program,
      });
      return [{
        key: "billing-without-budget",
        emptyMessage: "No recorded activity lacks matching Program authorization on its service date.",
        source: transactionTableSource(filters),
        columns: [
          { key: "individualName", header: "Individual", type: "text" },
          { key: "programName", header: "Program", type: "text" },
          { key: "firstServiceDate", header: "First service", type: "date" },
          { key: "lastServiceDate", header: "Last service", type: "date" },
          { key: "transactionCount", header: "Transactions", type: "int" },
          { key: "recordedHours", header: "Recorded hours", type: "hours" },
          { key: "funderBilled", header: "Funder billed", type: "money" },
          sourceColumn("Ledger source", "Open transactions"),
        ],
        rows: rows.map((row) => ({
          individualName: row.individualName,
          individualId: row.individualId,
          programName: row.programCode
            ? `${row.programCode} — ${row.programName ?? ""}`.replace(/ — $/, "")
            : row.programName ?? "Unassigned",
          firstServiceDate: row.firstServiceDate,
          lastServiceDate: row.lastServiceDate,
          transactionCount: row.transactionCount,
          recordedHours: row.recordedHours,
          funderBilled: row.funderBilled,
          sourceHref: row.sourceHref,
        })),
      }];
    },
  },

  transactions: {
    key: "transactions",
    title: "Transactions",
    description:
      "Committed transaction activity with canonical service date, people, Program, hours, money stages, payment route, source check, and exact ledger link.",
    filters: [
      ...DATE_FILTERS,
      { key: "employee", label: "Employee", type: "text", placeholder: "Name" },
      { key: "individual", label: "Individual", type: "text", placeholder: "Name" },
      { key: "program", label: "Program", type: "text", placeholder: "Code or name" },
      { key: "checkNumber", label: "Check number", type: "text", placeholder: "Number" },
    ],
    async run(pool, filters) {
      const rows = await transactionsReport(pool, {
        from: filters.from,
        to: filters.to,
        employee: filters.employee,
        individual: filters.individual,
        program: filters.program,
        checkNumber: filters.checkNumber,
      });
      return [{
        key: "transactions",
        emptyMessage: "No committed transactions match this scope.",
        source: transactionTableSource(filters),
        columns: [
          { key: "serviceDate", header: "Service date", type: "date" },
          { key: "checkNumber", header: "Check number", type: "text" },
          { key: "employeeName", header: "Employee", type: "text" },
          { key: "individualName", header: "Individual", type: "text" },
          { key: "programName", header: "Program", type: "text" },
          { key: "hours", header: "Hours", type: "hours" },
          { key: "funderBilled", header: "Funder billed", type: "money" },
          { key: "employeeBase", header: "Employee base", type: "money" },
          { key: "agencySpread", header: "Agency spread", type: "money" },
          { key: "checkNet", header: "Source check net (repeated)", type: "money" },
          { key: "recipient", header: "Payment recipient", type: "text" },
          { key: "sourceName", header: "Import source", type: "text" },
          { key: "sourceSheet", header: "Sheet", type: "text" },
          { key: "sourceRowNumber", header: "Source row", type: "int" },
          sourceColumn("Ledger source", "Open transaction"),
        ],
        rows: rows.map((row) => ({
          serviceDate: row.serviceDate ?? null,
          checkNumber: row.checkNumber,
          employeeName: row.employee,
          employeeId: row.employeeId,
          individualName: row.individual,
          individualId: row.individualId,
          programName: row.programCode
            ? `${row.programCode} — ${row.program ?? ""}`.replace(/ — $/, "")
            : row.program,
          hours: row.hours,
          funderBilled: row.gross,
          employeeBase: transactionEmployeeBase(row),
          agencySpread: row.agencyAdditional,
          checkNet: row.totalNetPay == null ? null : toMoney(row.totalNetPay),
          recipient: row.paymentRecipient,
          sourceName: row.sourceName ?? null,
          sourceSheet: row.sourceSheet ?? null,
          sourceRowNumber: row.sourceRowNumber ?? null,
          sourceHref: transactionSourceHref(row),
        })),
      }];
    },
  },

  "agency-earnings": {
    key: "agency-earnings",
    title: "Billing spread by Program",
    description:
      "Agency gross, internal amount and agency additional per program, kept as three separate columns. Agency additional is agency gross less internal.",
    filters: DATE_FILTERS,
    async run(pool, filters) {
      const rows = await agencyEarningsReport(pool, { from: filters.from, to: filters.to });
      return [
        {
          key: "agency-earnings",
          emptyMessage: "No transactions fall in this date range.",
          source: transactionTableSource(filters),
          columns: [
            { key: "programName", header: "Program", type: "text" },
            { key: "agencyGross", header: "Funder billed", type: "money" },
            { key: "internalAmount", header: "Employee base", type: "money" },
            { key: "agencyAdditional", header: "Agency spread", type: "money" },
            { key: "transactionCount", header: "Transactions", type: "int" },
            sourceColumn("Ledger source", "Open transactions"),
          ],
          rows: rows.map((r) => ({
            programName: r.programName ?? r.programCode ?? "Unassigned",
            agencyGross: r.agencyGross,
            internalAmount: r.internalAmount,
            agencyAdditional: r.agencyAdditional,
            transactionCount: r.transactionCount,
            sourceHref: txLink({
              programCode: r.programCode,
              program: r.programCode ? null : r.programName,
              serviceFrom: asDate(filters.from),
              serviceTo: asDate(filters.to),
            }),
          })),
        },
      ];
    },
  },

  "employee-payable": {
    key: "employee-payable",
    title: "Employee Base by recipient",
    description:
      "Employee payment per employee, split by who it is paid to: directly to the employee, payable by the agency (Excellent Staffing), or an unresolved recipient.",
    filters: DATE_FILTERS,
    async run(pool, filters) {
      const rows = await employeePayableReport(pool, { from: filters.from, to: filters.to });
      return [
        {
          key: "employee-payable",
          emptyMessage: "No employee payments fall in this date range.",
          source: transactionTableSource(filters),
          columns: [
            { key: "employeeName", header: "Employee", type: "text" },
            { key: "totalPayment", header: "Employee base", type: "money" },
            { key: "paidToEmployee", header: "Paid directly", type: "money" },
            { key: "payableByAgency", header: "Agency pays", type: "money" },
            { key: "unknownRecipient", header: "Recipient unresolved", type: "money" },
            { key: "physicalHours", header: "Physical hours", type: "hours" },
            { key: "checkCount", header: "Checks", type: "int" },
            sourceColumn("Ledger source", "Open transactions"),
          ],
          rows: rows.map((r) => ({
            employeeName: r.employeeName,
            employeeId: r.employeeId,
            totalPayment: r.totalPayment,
            paidToEmployee: r.paidToEmployee,
            payableByAgency: r.payableByAgency,
            unknownRecipient: r.unknownRecipient,
            physicalHours: r.physicalHours,
            checkCount: r.checkCount,
            sourceHref: txLink({
              employeeId: r.employeeId,
              serviceFrom: asDate(filters.from),
              serviceTo: asDate(filters.to),
            }),
          })),
        },
      ];
    },
  },

  "program-totals": {
    key: "program-totals",
    title: "Program totals",
    description:
      "Credited hours repeat for each individual served. Physical hours count a linked employee session once; historical group rows without a session link remain separate transaction entries.",
    filters: DATE_FILTERS,
    async run(pool, filters) {
      const rows = await programTotalsReport(pool, { from: filters.from, to: filters.to });
      return [
        {
          key: "program-totals",
          emptyMessage: "No programs are configured.",
          source: transactionTableSource(filters),
          columns: [
            { key: "programName", header: "Program", type: "text" },
            { key: "individualsServed", header: "Individuals", type: "int" },
            { key: "employees", header: "Employees", type: "int" },
            { key: "creditedIndividualHours", header: "Credited individual hours", type: "hours" },
            { key: "physicalEmployeeHours", header: "Physical employee hours", type: "hours" },
            { key: "agencyGross", header: "Funder billed", type: "money" },
            { key: "internalAmount", header: "Employee base", type: "money" },
            { key: "agencyAdditional", header: "Agency spread", type: "money" },
            { key: "groupSessions", header: "Group sessions", type: "int" },
            sourceColumn("Ledger source", "Open transactions"),
          ],
          rows: rows.map((r) => ({
            programName: r.programName,
            individualsServed: r.individualsServed,
            employees: r.employees,
            creditedIndividualHours: r.creditedIndividualHours,
            physicalEmployeeHours: r.physicalEmployeeHours,
            agencyGross: r.agencyGross,
            internalAmount: r.internalAmount,
            agencyAdditional: r.agencyAdditional,
            groupSessions: r.groupSessions,
            sourceHref: txLink({
              programCode: r.programCode,
              serviceFrom: asDate(filters.from),
              serviceTo: asDate(filters.to),
            }),
          })),
        },
      ];
    },
  },

  "expiring-authorizations": {
    key: "expiring-authorizations",
    title: "Renewal pipeline",
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
          source: { href: "/individuals?view=renewing", label: "Open the renewal roster" },
          columns: [
            { key: "individualName", header: "Individual", type: "text" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "endDate", header: "Ends", type: "date" },
            { key: "renewalDate", header: "Renews", type: "date" },
            { key: "daysRemaining", header: "Days left", type: "int" },
            { key: "authorizedHours", header: "Authorized", type: "hours" },
            { key: "usedHours", header: "Used", type: "hours" },
            sourceColumn("Budget source", "Open budget"),
          ],
          rows: rows.map((r) => ({
            individualName: r.individualName,
            individualId: r.individualId,
            programCode: r.programCode,
            endDate: r.endDate,
            renewalDate: r.renewalDate,
            daysRemaining: r.daysRemaining,
            authorizedHours: r.authorizedHours,
            usedHours: r.usedHours,
            sourceHref: `/individuals/${encodeURIComponent(r.individualId)}?view=budget`,
          })),
        },
      ];
    },
  },

  "missing-config": {
    key: "missing-config",
    title: "Missing configuration",
    description:
      "Active individuals with an operational authorization but no active employee assignment.",
    filters: [],
    async run(pool) {
      const rows = await missingConfigurationReport(pool);
      return [
        {
          key: "missing-config",
          emptyMessage: "Every authorized individual has an active assignment.",
          source: { href: "/schedule?view=future", label: "Open Assignments" },
          columns: [
            { key: "individualName", header: "Individual", type: "text" },
            { key: "programsAuthorized", header: "Authorized programs", type: "text" },
            sourceColumn("Configuration source", "Open Individual"),
          ],
          rows: rows.map((r) => ({
            individualName: r.individualName,
            individualId: r.individualId,
            programsAuthorized: r.programsAuthorized,
            sourceHref: `/individuals/${encodeURIComponent(r.individualId)}?view=activity`,
          })),
        },
      ];
    },
  },

  "missing-rates": {
    key: "missing-rates",
    title: "Missing rates",
    description: "Active programs with no rate schedule in force today.",
    filters: [],
    async run(pool) {
      const rows = await missingRatesReport(pool);
      return [{
        key: "missing-rates",
        emptyMessage: "Every active program has a rate in force.",
        source: { href: "/settings#programs", label: "Open Program rates" },
        columns: [
          { key: "programCode", header: "Code", type: "text" },
          { key: "programName", header: "Program", type: "text" },
          sourceColumn("Configuration source", "Open Program rates"),
        ],
        rows: rows.map((row) => ({
          programCode: row.programCode,
          programName: row.programName,
          sourceHref: "/settings#programs",
        })),
      }];
    },
  },

  "unbilled-schedules": {
    key: "unbilled-schedules",
    title: "Scheduled not recorded",
    description:
      "Planned sessions in the date range that have not been linked to an imported transaction. This is match state, not independent proof that no corresponding transaction exists.",
    filters: DATE_FILTERS,
    async run(pool, filters) {
      const lines = await listScheduledForReconcile(
        pool,
        { from: filters.from ?? "", to: filters.to ?? "" },
        true,
        null,
      );
      return [
        {
          key: "unbilled-schedules",
          emptyMessage: "No unmatched planned sessions in this range.",
          source: { href: "/schedule?view=matching", label: "Open recorded match review" },
          note: "Complete result set: this report intentionally requests no row cap.",
          columns: [
            { key: "sessionDate", header: "Date", type: "date" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "individuals", header: "Individuals", type: "text" },
            { key: "isGroup", header: "Group", type: "text" },
            { key: "hours", header: "Hours", type: "hours" },
            { key: "expectedInternal", header: "Expected Employee base", type: "money" },
            sourceColumn("Schedule source", "Open visit"),
          ],
          rows: lines.map((l) => ({
            sessionDate: l.sessionDate,
            programCode: l.programCode,
            individuals: l.individualNames.join(", "),
            isGroup: l.isGroup ? "Group" : "1:1",
            hours: l.hours,
            expectedInternal: l.expectedInternal,
            sourceHref: `/schedule?view=calendar&calendarView=day&date=${encodeURIComponent(l.sessionDate)}&sessionId=${encodeURIComponent(l.id)}`,
          })),
        },
      ];
    },
  },

  "unscheduled-billing": {
    key: "unscheduled-billing",
    title: "Recorded not scheduled",
    description:
      "Imported transactions in the date range that are not linked to a planned session. This is match state, not independent proof that no corresponding visit was scheduled.",
    filters: DATE_FILTERS,
    async run(pool, filters) {
      const lines = await listBilledNotScheduled(
        pool,
        { from: filters.from ?? "", to: filters.to ?? "" },
        null,
      );
      return [
        {
          key: "unscheduled-billing",
          emptyMessage: "Every transaction in this range matches a planned session.",
          source: transactionTableSource(filters),
          note: "Complete result set: this report intentionally requests no row cap.",
          columns: [
            { key: "periodBegin", header: "Period begin", type: "date" },
            { key: "periodEnd", header: "Period end", type: "date" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "individualName", header: "Individual", type: "text" },
            { key: "hours", header: "Hours", type: "hours" },
            { key: "amount", header: "Funder billed", type: "money" },
            sourceColumn("Ledger source", "Open transaction"),
          ],
          rows: lines.map((l) => ({
            periodBegin: l.periodBegin,
            periodEnd: l.periodEnd,
            programCode: l.programCode,
            individualName: l.individualName,
            hours: l.hours,
            amount: l.amount,
            transactionId: l.id,
            sourceHref: txLink({ transactionId: l.id }),
          })),
        },
      ];
    },
  },

  "cuts-monthly": {
    key: "cuts-monthly",
    title: "Financial setup audit",
    description:
      "Every active setup's waterfall: yearly and monthly gross, both sequential cuts, adjustments, calculated net, and the entered approved monthly final.",
    filters: [{ key: "program", label: "Program", type: "text", placeholder: "Code or name" }],
    async run(pool, filters) {
      const rows = await cutsMonthlyReport(pool, { program: filters.program });
      return [
        {
          key: "cuts-monthly",
          emptyMessage: "No active calculations match this filter.",
          source: { href: "/calculations", label: "Open Financial setup" },
          columns: [
            { key: "individualName", header: "Individual", type: "text" },
            { key: "setupName", header: "Setup", type: "text" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "annualGross", header: "Yearly gross", type: "money" },
            { key: "monthlyGross", header: "Monthly gross", type: "money" },
            { key: "cut1Amount", header: "Cut 1", type: "money" },
            { key: "cut2Amount", header: "Cut 2", type: "money" },
            { key: "clockAdjustment", header: "Clock adj.", type: "money" },
            { key: "otherAdjustment", header: "Other adj.", type: "money" },
            { key: "calculatedNet", header: "Calculated net", type: "money" },
            { key: "approvedFinal", header: "Approved final / month", type: "money" },
            { key: "difference", header: "Override difference", type: "money" },
            sourceColumn("Setup source", "Open setup"),
          ],
          rows: rows.map((r) => ({
            individualName: r.individualName,
            individualId: r.individualId,
            setupName: r.setupName,
            programCode: r.programCode,
            annualGross: r.annualGross,
            monthlyGross: r.monthlyGross,
            cut1Amount: r.cut1Amount,
            cut2Amount: r.cut2Amount,
            clockAdjustment: r.clockAdjustment,
            otherAdjustment: r.otherAdjustment,
            calculatedNet: r.calculatedNet,
            approvedFinal: r.approvedFinal,
            difference: r.difference,
            sourceHref: `/individuals/${encodeURIComponent(r.individualId)}?view=financial`,
          })),
        },
      ];
    },
  },

  "unverified-checks": {
    key: "unverified-checks",
    title: "Unverified checks",
    description:
      "Payroll-check facts still marked unverified. Amounts are intentionally omitted until verification is complete.",
    filters: [
      ...DATE_FILTERS,
      { key: "employee", label: "Employee", type: "text", placeholder: "Name" },
      { key: "source", label: "Source", type: "text", placeholder: "Source or reference" },
    ],
    async run(pool, filters) {
      const rows = await unverifiedChecksReport(pool, {
        from: filters.from,
        to: filters.to,
        employee: filters.employee,
        source: filters.source,
      });
      return [{
        key: "unverified-checks",
        emptyMessage: "No unverified payroll checks match this scope.",
        source: { href: "/masser", label: "Open Payroll checks" },
        note: "Gross, net, and withholding are excluded until a check is verified.",
        columns: [
          { key: "employeeName", header: "Employee", type: "text" },
          { key: "checkNumber", header: "Check number", type: "text" },
          { key: "checkDate", header: "Check date", type: "date" },
          { key: "periodBegin", header: "Period begin", type: "date" },
          { key: "periodEnd", header: "Period end", type: "date" },
          { key: "source", header: "Source", type: "text" },
          { key: "sourceRef", header: "Source reference", type: "text" },
          { key: "linkedTransactions", header: "Linked transactions", type: "int" },
          { key: "createdAt", header: "Recorded", type: "text" },
          sourceColumn("Check source", "Open check"),
        ],
        rows: rows.map((row) => ({
          employeeName: row.employeeName,
          employeeId: row.employeeId,
          checkNumber: row.checkNumber,
          checkDate: row.checkDate,
          periodBegin: row.periodBegin,
          periodEnd: row.periodEnd,
          source: row.source,
          sourceRef: row.sourceRef,
          linkedTransactions: row.linkedTransactions,
          createdAt: row.createdAt,
          sourceHref: row.sourceHref,
        })),
      }];
    },
  },

  "import-conflicts": {
    key: "import-conflicts",
    title: "Import conflicts",
    description:
      "Changed or missing Sheet rows, including both the open decision queue and retained resolution history.",
    filters: [
      ...DATE_FILTERS,
      {
        key: "status",
        label: "Status",
        type: "select",
        options: [
          { value: "", label: "Open and resolved" },
          { value: "open", label: "Open" },
          { value: "resolved", label: "Resolved / history" },
        ],
      },
      {
        key: "type",
        label: "Conflict",
        type: "select",
        options: [
          { value: "", label: "Changed and missing" },
          { value: "changed", label: "Changed" },
          { value: "missing", label: "Missing" },
        ],
      },
    ],
    async run(pool, filters) {
      const rows = await importConflictsReport(pool, {
        from: filters.from,
        to: filters.to,
        status: filters.status,
        type: filters.type,
      });
      const table = (
        key: string,
        title: string,
        matching: typeof rows,
        emptyMessage: string,
      ): ReportTable => ({
        key,
        title,
        emptyMessage,
        source: { href: "/sync#sync-conflicts", label: "Open Sync conflicts" },
        columns: [
          { key: "createdAt", header: "Detected", type: "text" },
          { key: "type", header: "Conflict", type: "text" },
          { key: "status", header: "Status", type: "text" },
          { key: "individualName", header: "Individual", type: "text" },
          { key: "employeeName", header: "Employee", type: "text" },
          { key: "programName", header: "Program", type: "text" },
          { key: "detail", header: "Detail", type: "text" },
          { key: "resolution", header: "Resolution", type: "text" },
          { key: "resolutionNote", header: "Resolution note", type: "text" },
          { key: "resolvedBy", header: "Resolved by", type: "text" },
          { key: "resolvedAt", header: "Resolved", type: "text" },
          sourceColumn("Review source", "Open source"),
        ],
        rows: matching.map((row) => ({
          createdAt: row.createdAt,
          type: row.type,
          status: row.status,
          individualName: row.individualName,
          employeeName: row.employeeName,
          programName: row.programName,
          detail: row.detail,
          resolution: row.resolution,
          resolutionNote: row.resolutionNote,
          resolvedBy: row.resolvedBy,
          resolvedAt: row.resolvedAt,
          sourceHref: row.sourceHref,
        })),
      });
      return [
        table(
          "open-import-conflicts",
          "Open conflicts",
          rows.filter((row) => row.status === "open"),
          "No open import conflicts match this scope.",
        ),
        table(
          "resolved-import-conflicts",
          "Resolved / history",
          rows.filter((row) => row.status !== "open"),
          "No resolved import conflicts match this scope.",
        ),
      ];
    },
  },

  "alias-decisions": {
    key: "alias-decisions",
    title: "Alias and merge history",
    description:
      "Alias decisions plus immutable merge lineage: survivor, folded source, repointed records, actor, date, and reason.",
    filters: [
      ...DATE_FILTERS,
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
      const [aliases, merges] = await Promise.all([
        aliasDecisionsReport(pool, {
          kind: filters.kind,
          status: filters.status,
          from: filters.from,
          to: filters.to,
        }),
        mergeHistoryReport(pool, {
          kind: filters.kind,
          from: filters.from,
          to: filters.to,
        }),
      ]);
      return [
        {
          key: "alias-decisions",
          title: "Alias decisions",
          emptyMessage: "No aliases match this filter.",
          source: { href: "/aliases", label: "Open Alias review" },
          columns: [
            { key: "sourceText", header: "Imported spelling", type: "text" },
            { key: "normalizedAlias", header: "Normalized", type: "text" },
            { key: "canonicalName", header: "Canonical", type: "text" },
            { key: "kind", header: "Kind", type: "text" },
            { key: "status", header: "Status", type: "text" },
            { key: "approvedBy", header: "Approved by", type: "text" },
            { key: "createdAt", header: "Created", type: "date" },
            sourceColumn("Canonical source", "Open canonical person"),
          ],
          rows: aliases.map((r) => ({
            sourceText: r.sourceText,
            normalizedAlias: r.normalizedAlias,
            canonicalName: r.canonicalName,
            kind: r.kind,
            status: r.status,
            approvedBy: r.approvedBy,
            createdAt: r.createdAt,
            sourceHref: r.kind === "individual"
              ? `/individuals/${encodeURIComponent(r.canonicalId)}`
              : `/employees/${encodeURIComponent(r.canonicalId)}`,
          })),
        },
        {
          key: "merge-history",
          title: "Merge history",
          emptyMessage: "No person merges match this filter.",
          source: { href: "/matches", label: "Open Identity matches" },
          columns: [
            { key: "mergedAt", header: "Merged", type: "text" },
            { key: "kind", header: "Kind", type: "text" },
            { key: "survivorName", header: "Survivor", type: "text" },
            { key: "survivorId", header: "Survivor ID", type: "text" },
            { key: "foldedName", header: "Folded source", type: "text" },
            { key: "foldedId", header: "Folded source ID", type: "text" },
            { key: "repointed", header: "Repointed lineage", type: "text" },
            { key: "actor", header: "Actor", type: "text" },
            { key: "reason", header: "Reason", type: "text" },
            sourceColumn("Survivor source", "Open survivor"),
          ],
          rows: merges.map((row) => ({
            mergedAt: row.mergedAt,
            kind: row.kind,
            survivorName: row.survivorName,
            survivorId: row.survivorId,
            foldedName: row.foldedName,
            foldedId: row.foldedId,
            repointed: row.repointed,
            actor: row.actor,
            reason: row.reason,
            sourceHref: row.sourceHref,
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
          source: { href: "/settings", label: "Open the audit summary" },
          columns: [
            { key: "timestamp", header: "When", type: "text" },
            { key: "actor", header: "Actor", type: "text" },
            { key: "action", header: "Action", type: "text" },
            { key: "entityType", header: "Entity", type: "text" },
            { key: "entityId", header: "Entity ID", type: "text" },
            { key: "reason", header: "Reason", type: "text" },
            sourceColumn("Record source", "Open record"),
          ],
          rows: rows.map((r) => ({
            timestamp: r.timestamp,
            actor: r.actor,
            action: r.action,
            entityType: r.entityType,
            entityId: r.entityId,
            reason: r.reason,
            sourceHref: r.sourceHref,
          })),
        },
      ];
    },
  },

  "group-activity": {
    key: "group-activity",
    title: "Group services",
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
          source: {
            href: txLink({
              group: "1",
              program: filters.program,
              serviceFrom: asDate(filters.from),
              serviceTo: asDate(filters.to),
            }),
            label: "Open group transactions",
          },
          columns: [
            { key: "programCode", header: "Program", type: "text" },
            { key: "employeeName", header: "Employee", type: "text" },
            { key: "periodBegin", header: "Period begin", type: "date" },
            { key: "periodEnd", header: "Period end", type: "date" },
            { key: "groupSize", header: "Group size", type: "int" },
            { key: "memberCount", header: "Members", type: "int" },
            { key: "combinedAmount", header: "Funder billed", type: "money" },
            { key: "detectionStatus", header: "Detection", type: "text" },
            sourceColumn("Ledger source", "Open transactions"),
          ],
          rows: data.sessions.map((r) => ({
            programCode: r.programCode,
            employeeName: r.employeeName,
            employeeId: r.employeeId,
            periodBegin: r.periodBegin,
            periodEnd: r.periodEnd,
            groupSize: r.groupSize,
            memberCount: r.memberCount,
            combinedAmount: r.combinedAmount,
            detectionStatus: r.detectionStatus,
            sourceHref: r.transactionIds.length > 0
              ? txLink({ transactionIds: r.transactionIds })
              : txLink({
                  employeeId: r.employeeId,
                  programCode: r.programCode,
                  group: "1",
                  serviceFrom: r.periodBegin ?? asDate(filters.from),
                  serviceTo: r.periodEnd ?? asDate(filters.to),
                }),
          })),
        },
        {
          key: "scheduled-group-counts",
          title: "Planned group sessions",
          emptyMessage: "No planned group sessions in this range.",
          source: { href: "/schedule?view=calendar", label: "Open the Schedule calendar" },
          columns: [
            { key: "programCode", header: "Program", type: "text" },
            { key: "programName", header: "Program name", type: "text" },
            { key: "sessionCount", header: "Planned group sessions", type: "int" },
            sourceColumn("Schedule source", "Open schedule"),
          ],
          rows: data.scheduledCounts.map((r) => ({
            programCode: r.programCode,
            programName: r.programName,
            sessionCount: r.sessionCount,
            sourceHref: `/schedule?view=calendar${r.programId ? `&programId=${encodeURIComponent(r.programId)}` : ""}`,
          })),
        },
      ];
    },
  },

  "employee-activity": {
    key: "employee-activity",
    title: "Employee activity",
    description:
      "Recorded activity across all Employees, with credited hours, physical session hours, people served, Programs, Funder billed, and Employee base.",
    filters: [
      ...DATE_FILTERS,
      { key: "employee", label: "Employee", type: "text", placeholder: "Name" },
      { key: "program", label: "Program", type: "text", placeholder: "Code or name" },
    ],
    async run(pool, filters) {
      const rows = await employeeActivityReport(pool, {
        from: filters.from,
        to: filters.to,
        employee: filters.employee,
        program: filters.program,
      });
      return [{
        key: "employee-activity",
        emptyMessage: "No Employee activity matches this scope.",
        source: transactionTableSource(filters),
        columns: [
          { key: "employeeName", header: "Employee", type: "text" },
          { key: "firstServiceDate", header: "First service", type: "date" },
          { key: "lastServiceDate", header: "Last service", type: "date" },
          { key: "transactionCount", header: "Transactions", type: "int" },
          { key: "individualCount", header: "Individuals", type: "int" },
          { key: "programCount", header: "Programs", type: "int" },
          { key: "creditedHours", header: "Credited hours", type: "hours" },
          { key: "physicalHours", header: "Physical hours", type: "hours" },
          { key: "groupSessions", header: "Group sessions", type: "int" },
          { key: "funderBilled", header: "Funder billed", type: "money" },
          { key: "employeeBase", header: "Employee base", type: "money" },
          sourceColumn("Ledger source", "Open transactions"),
        ],
        rows: rows.map((row) => ({
          employeeName: row.employeeName,
          employeeId: row.employeeId,
          firstServiceDate: row.firstServiceDate,
          lastServiceDate: row.lastServiceDate,
          transactionCount: row.transactionCount,
          individualCount: row.individualCount,
          programCount: row.programCount,
          creditedHours: row.creditedHours,
          physicalHours: row.physicalHours,
          groupSessions: row.groupSessions,
          funderBilled: row.funderBilled,
          employeeBase: row.employeeBase,
          sourceHref: row.sourceHref,
        })),
      }];
    },
  },

  "actual-vs-scheduled": {
    key: "actual-vs-scheduled",
    title: "Actual versus scheduled",
    description:
      "Per individual and program: scheduled hours and expected Employee base compared with committed transaction hours and recorded Employee base.",
    filters: [
      ...DATE_FILTERS,
      { key: "individual", label: "Individual", type: "text", placeholder: "Name" },
      { key: "employee", label: "Employee", type: "text", placeholder: "Name" },
      { key: "program", label: "Program", type: "text", placeholder: "Code or name" },
    ],
    async run(pool, filters) {
      const rows = await actualVsScheduledReport(pool, {
        from: filters.from,
        to: filters.to,
        individual: filters.individual,
        employee: filters.employee,
        program: filters.program,
      });
      return [
        {
          key: "actual-vs-scheduled",
          emptyMessage: "No scheduled or actual activity to compare.",
          source: { href: "/schedule?view=calendar", label: "Open the Schedule calendar" },
          columns: [
            { key: "individualName", header: "Individual", type: "text" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "scheduledHours", header: "Scheduled hours", type: "hours" },
            { key: "actualHours", header: "Actual hours", type: "hours" },
            { key: "hoursVariance", header: "Hours variance", type: "hours" },
            { key: "scheduledInternal", header: "Scheduled Employee base", type: "money" },
            { key: "actualInternal", header: "Recorded Employee base", type: "money" },
            { key: "internalVariance", header: "Employee base variance", type: "money" },
            { key: "scheduleHref", header: "Schedule source", type: "text", linkLabel: "Open schedule" },
            { key: "transactionHref", header: "Recorded source", type: "text", linkLabel: "Open transactions" },
          ],
          rows: rows.map((r) => ({
            individualName: r.individualName,
            individualId: r.individualId,
            programCode: r.programCode,
            scheduledHours: r.scheduledHours,
            actualHours: r.actualHours,
            hoursVariance: r.hoursVariance,
            scheduledInternal: r.scheduledInternal,
            actualInternal: r.actualInternal,
            internalVariance: r.internalVariance,
            scheduleHref: `/schedule?view=calendar&individualId=${encodeURIComponent(r.individualId)}${r.programId ? `&programId=${encodeURIComponent(r.programId)}` : ""}${asDate(filters.from) ? `&date=${encodeURIComponent(asDate(filters.from)!)}` : ""}`,
            transactionHref: txLink({
              individualId: r.individualId,
              programCode: r.programCode,
              serviceFrom: asDate(filters.from),
              serviceTo: asDate(filters.to),
            }),
          })),
        },
      ];
    },
  },

  "utilization-outliers": {
    key: "utilization-outliers",
    title: "Budget exceptions",
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
          source: { href: "/individuals?view=attention", label: "Open the budget attention roster" },
          columns: [
            { key: "individualName", header: "Individual", type: "text" },
            { key: "programCode", header: "Program", type: "text" },
            { key: "periodLabel", header: "Period", type: "text" },
            { key: "authorizedHours", header: "Authorized", type: "hours" },
            { key: "usedHours", header: "Used", type: "hours" },
            { key: "remainingHours", header: "Remaining", type: "hours" },
            { key: "percentUsed", header: "% used", type: "percent" },
            { key: "flag", header: "Flag", type: "text" },
            sourceColumn("Budget source", "Open budget"),
          ],
          rows: rows.map((r) => ({
            individualName: r.individualName,
            individualId: r.individualId,
            programCode: r.programCode,
            periodLabel: r.periodLabel,
            authorizedHours: r.authorizedHours,
            usedHours: r.usedHours,
            remainingHours: r.remainingHours,
            percentUsed: r.percentUsed,
            flag: r.flag,
            sourceHref: `/individuals/${encodeURIComponent(r.individualId)}?view=budget`,
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
