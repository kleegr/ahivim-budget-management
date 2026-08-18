import { dec, toMoney, toHours } from "@/lib/money";
import type { PgLikePool } from "@/lib/import/commit";
import type { RateConfig } from "@/lib/import/stage";
import {
  calculatePeriodElapsed,
  calculateProgramUtilization,
  classifyUtilization,
  type ProgramUtilizationResult,
  type PeriodElapsed,
  type UtilizationStatus,
} from "@/lib/business/utilization";
import { calculateForecast, type ForecastResult } from "@/lib/business/forecast";
import { resolveEffectiveRate } from "@/lib/business/rate-resolver";

/**
 * READ MODEL
 * ==========
 *
 * Every reporting figure the application shows is produced here, so there is
 * exactly one definition of "used hours" in the system.
 *
 * Two rules run through all of it:
 *
 *  1. Money and hours are selected as ::text and handled with decimal.js.
 *     PostgreSQL numeric never becomes a JavaScript float on the way to a
 *     screen or a CSV.
 *
 *  2. UNRESOLVED ROWS ARE EXCLUDED FROM OFFICIAL UTILIZATION. A row staged
 *     `needs_review` never became a payroll transaction, so it cannot reach
 *     these queries at all. It is still visible - `unresolvedRowCount` below
 *     reads import_rows directly - so a budget is never quietly understated
 *     without saying so. See docs/business-rules.md.
 */

/* -------------------------------------------------------------------------- */
/* Rates                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The rate in force for each program on `asOf`.
 *
 * Rates are effective-dated: a schedule row applies from effective_from until
 * effective_to, and an open-ended row (null effective_to) applies indefinitely.
 * When several rows overlap, the latest effective_from wins, which makes a
 * correction as simple as inserting a newer row.
 */
export async function currentRatesByProgram(
  pool: PgLikePool,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<Record<string, RateConfig>> {
  const { rows } = await pool.query<{
    code: string;
    agency_rate: string | null;
    internal_rate: string;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT p.code,
            s.agency_rate::text    AS agency_rate,
            s.internal_rate::text  AS internal_rate,
            s.effective_from::text AS effective_from,
            s.effective_to::text   AS effective_to
       FROM programs p
       JOIN program_rate_schedules s ON s.program_id = p.id`,
  );

  // Group by program, then let the ONE resolver pick the row in force on asOf.
  const byCode = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byCode.get(row.code) ?? [];
    list.push(row);
    byCode.set(row.code, list);
  }

  const out: Record<string, RateConfig> = {};
  for (const [code, scheduleRows] of byCode) {
    const resolved = resolveEffectiveRate(
      scheduleRows.map((r) => ({
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
        agencyRate: r.agency_rate,
        internalRate: r.internal_rate,
      })),
      asOf,
    );
    if (resolved === null) continue;
    out[code] = {
      agencyRate: resolved.agencyRate === null ? null : toMoney(resolved.agencyRate),
      internalRate: toMoney(resolved.internalRate),
    };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export interface DashboardSummary {
  individuals: number;
  employees: number;
  transactions: number;
  serviceSessions: number;
  groupSessions: number;
  openRateExceptions: number;
  reviewRows: number;
  imports: number;
  agencyGross: string;
  internalAmount: string;
}

export async function dashboardSummary(pool: PgLikePool): Promise<DashboardSummary> {
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM individuals)::text                                   AS individuals,
       (SELECT count(*) FROM employees)::text                                     AS employees,
       (SELECT count(*) FROM payroll_transactions)::text                          AS transactions,
       (SELECT count(*) FROM service_sessions)::text                              AS service_sessions,
       (SELECT count(*) FROM service_sessions WHERE group_size > 1)::text         AS group_sessions,
       (SELECT count(*) FROM rate_exceptions WHERE resolution = 'open')::text     AS open_rate_exceptions,
       (SELECT count(*) FROM import_rows WHERE status = 'needs_review')::text     AS review_rows,
       (SELECT count(*) FROM import_batches WHERE status = 'committed')::text     AS imports,
       (SELECT coalesce(sum(imported_amount), 0) FROM payroll_transactions)::text AS agency_gross,
       (SELECT coalesce(sum(calculated_internal_amount), 0)
          FROM payroll_transactions)::text                                        AS internal_amount`,
  );
  const r = rows[0] ?? {};
  return {
    individuals: Number(r.individuals ?? 0),
    employees: Number(r.employees ?? 0),
    transactions: Number(r.transactions ?? 0),
    serviceSessions: Number(r.service_sessions ?? 0),
    groupSessions: Number(r.group_sessions ?? 0),
    openRateExceptions: Number(r.open_rate_exceptions ?? 0),
    reviewRows: Number(r.review_rows ?? 0),
    imports: Number(r.imports ?? 0),
    agencyGross: toMoney(r.agency_gross ?? "0"),
    internalAmount: toMoney(r.internal_amount ?? "0"),
  };
}

/* -------------------------------------------------------------------------- */
/* Individuals                                                                */
/* -------------------------------------------------------------------------- */

export interface IndividualListRow {
  id: string;
  displayName: string;
  normalizedName: string;
  transactionCount: number;
  agencyGross: string;
}

export async function listIndividuals(pool: PgLikePool): Promise<IndividualListRow[]> {
  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    normalized_name: string;
    transaction_count: string;
    agency_gross: string;
  }>(
    `SELECT i.id, i.display_name, i.normalized_name,
            count(t.id)::text                             AS transaction_count,
            coalesce(sum(t.imported_amount), 0)::text     AS agency_gross
       FROM individuals i
       LEFT JOIN payroll_transactions t ON t.individual_id = i.id
      GROUP BY i.id
      ORDER BY i.display_name`,
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    normalizedName: r.normalized_name,
    transactionCount: Number(r.transaction_count),
    agencyGross: toMoney(r.agency_gross),
  }));
}

export interface ProgramUsageRow {
  programCode: string;
  programName: string;
  /**
   * Billed hours for this individual, summed from payroll_transactions.imported_hours
   * so the figure matches the Transactions grid exactly. Each source row already
   * names one individual and carries that individual's full hours (a group session
   * appears as one row per member), so this credits each member correctly.
   */
  usedHours: string;
  transactionCount: number;
  agencyGross: string;
  internalAmount: string;
}

export interface IndividualReport {
  individual: { id: string; displayName: string; normalizedName: string };
  budgetPeriod: { id: string; label: string; startDate: string; endDate: string } | null;
  elapsed: PeriodElapsed | null;
  programs: {
    programCode: string;
    programName: string;
    utilization: ProgramUtilizationResult;
    forecast: ForecastResult | null;
  }[];
  usageByProgram: ProgramUsageRow[];
  totals: { agencyGross: string; internalAmount: string; usedHours: string };
  employeesServing: { id: string; displayName: string; hours: string }[];
  groupSessions: number;
  rateExceptions: number;
  importWarnings: number;
  /** Rows still awaiting a mapping decision. Excluded from the figures above. */
  unresolvedRowCount: number;
}

/**
 * Everything the individual report screen shows.
 *
 * Used hours come from service_allocations, not from payroll_transactions,
 * because allocations are where a group member's full-hours entitlement is
 * recorded. Summing transaction hours would divide a group's hours across its
 * members and understate every participant.
 */
export async function getIndividualReport(
  pool: PgLikePool,
  individualId: string,
  asOf: Date = new Date(),
): Promise<IndividualReport | null> {
  const { rows: people } = await pool.query<{
    id: string;
    display_name: string;
    normalized_name: string;
  }>(`SELECT id, display_name, normalized_name FROM individuals WHERE id = $1`, [individualId]);
  if (!people[0]) return null;

  const { rows: periods } = await pool.query<{
    id: string;
    label: string;
    start_date: string;
    end_date: string;
  }>(
    `SELECT id, label, start_date::text AS start_date, end_date::text AS end_date
       FROM budget_periods
      WHERE individual_id = $1
      ORDER BY start_date DESC
      LIMIT 1`,
    [individualId],
  );
  const period = periods[0] ?? null;
  const elapsed = period
    ? calculatePeriodElapsed({ startDate: period.start_date, endDate: period.end_date }, asOf)
    : null;

  // Billed activity comes straight from payroll_transactions.imported_hours and
  // imported_amount, so every figure here reconciles exactly to the Transactions
  // grid filtered to this individual (and, for a group row, still credits the one
  // individual named on that row its full hours). Two sums are returned per
  // program: all-time actual activity, and the amount that falls inside the
  // current budget period window — the window the authorization is measured
  // against, matching the workbook's SUMIFS over Period Begin.
  const periodStart = period?.start_date ?? null;
  const periodEnd = period?.end_date ?? null;
  const { rows: usage } = await pool.query<{
    program_code: string;
    program_name: string;
    used_hours: string;
    used_hours_period: string;
    transaction_count: string;
    agency_gross: string;
    agency_gross_period: string;
    internal_amount: string;
    internal_amount_period: string;
  }>(
    `SELECT p.code AS program_code,
            p.name AS program_name,
            coalesce(sum(t.imported_hours), 0)::text             AS used_hours,
            coalesce(sum(t.imported_hours) FILTER (
              WHERE $2::date IS NULL
                 OR (t.period_begin >= $2::date AND t.period_begin <= $3::date)), 0)::text
                                                                 AS used_hours_period,
            count(DISTINCT t.id)::text                           AS transaction_count,
            coalesce(sum(t.imported_amount), 0)::text            AS agency_gross,
            coalesce(sum(t.imported_amount) FILTER (
              WHERE $2::date IS NULL
                 OR (t.period_begin >= $2::date AND t.period_begin <= $3::date)), 0)::text
                                                                 AS agency_gross_period,
            coalesce(sum(t.calculated_internal_amount), 0)::text AS internal_amount,
            coalesce(sum(t.calculated_internal_amount) FILTER (
              WHERE $2::date IS NULL
                 OR (t.period_begin >= $2::date AND t.period_begin <= $3::date)), 0)::text
                                                                 AS internal_amount_period
       FROM payroll_transactions t
       JOIN programs p ON p.id = t.program_id
      WHERE t.individual_id = $1
      GROUP BY p.code, p.name
      ORDER BY p.name`,
    [individualId, periodStart, periodEnd],
  );

  const usageByProgram: ProgramUsageRow[] = usage.map((u) => ({
    programCode: u.program_code,
    programName: u.program_name,
    usedHours: toHours(u.used_hours),
    transactionCount: Number(u.transaction_count),
    agencyGross: toMoney(u.agency_gross),
    internalAmount: toMoney(u.internal_amount),
  }));
  const usageByCode = new Map(usageByProgram.map((u) => [u.programCode, u]));
  // Period-scoped billed hours/dollars, keyed by program, drive budget utilization.
  const periodByCode = new Map(
    usage.map((u) => [
      u.program_code,
      { usedHours: toHours(u.used_hours_period), agencyGross: toMoney(u.agency_gross_period) },
    ]),
  );

  const { rows: auths } = await pool.query<{
    program_code: string;
    program_name: string;
    authorized_hours: string;
    internal_rate: string;
  }>(
    `SELECT p.code AS program_code, p.name AS program_name,
            b.authorized_hours::text AS authorized_hours,
            b.internal_rate::text    AS internal_rate
       FROM budget_authorizations b
       JOIN programs p ON p.id = b.program_id
      WHERE b.individual_id = $1
        AND ($2::uuid IS NULL OR b.budget_period_id = $2::uuid)
      ORDER BY p.name`,
    [individualId, period?.id ?? null],
  );

  const programs = auths.map((a) => {
    const used = periodByCode.get(a.program_code);
    const observations = usageByCode.get(a.program_code)?.transactionCount ?? 0;
    const utilization = calculateProgramUtilization(
      {
        authorizedHours: a.authorized_hours,
        usedHours: used?.usedHours ?? "0",
        internalRate: a.internal_rate,
        agencyGross: used?.agencyGross ?? "0",
      },
      elapsed ?? notStartedElapsed(),
      {},
    );
    return {
      programCode: a.program_code,
      programName: a.program_name,
      utilization,
      forecast:
        elapsed && period
          ? calculateForecast({
              authorizedHours: a.authorized_hours,
              usedHours: used?.usedHours ?? "0",
              elapsed,
              periodStartDate: period.start_date,
              observationCount: observations,
            })
          : null,
    };
  });

  const { rows: staff } = await pool.query<{
    id: string;
    display_name: string;
    hours: string;
  }>(
    `SELECT e.id, e.display_name, coalesce(sum(t.imported_hours), 0)::text AS hours
       FROM payroll_transactions t
       JOIN employees e ON e.id = t.employee_id
      WHERE t.individual_id = $1
      GROUP BY e.id
      ORDER BY e.display_name`,
    [individualId],
  );

  const { rows: extra } = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(DISTINCT s.id)
          FROM service_allocations a JOIN service_sessions s ON s.id = a.service_session_id
         WHERE a.individual_id = $1 AND s.group_size > 1)::text             AS group_sessions,
       (SELECT count(*) FROM rate_exceptions WHERE individual_id = $1)::text AS rate_exceptions,
       (SELECT count(*) FROM import_warnings WHERE individual_id = $1)::text AS import_warnings,
       (SELECT count(*) FROM import_rows r
         WHERE r.status = 'needs_review'
           AND r.resolved_individual_id = $1)::text                          AS unresolved_rows`,
    [individualId],
  );
  const e = extra[0] ?? {};

  return {
    individual: {
      id: people[0].id,
      displayName: people[0].display_name,
      normalizedName: people[0].normalized_name,
    },
    budgetPeriod: period
      ? {
          id: period.id,
          label: period.label,
          startDate: period.start_date,
          endDate: period.end_date,
        }
      : null,
    elapsed,
    programs,
    usageByProgram,
    totals: {
      agencyGross: sumField(usageByProgram, "agencyGross"),
      internalAmount: sumField(usageByProgram, "internalAmount"),
      usedHours: toHours(usageByProgram.reduce((sum, u) => sum.plus(dec(u.usedHours)), dec(0))),
    },
    employeesServing: staff.map((s) => ({
      id: s.id,
      displayName: s.display_name,
      hours: toHours(s.hours),
    })),
    groupSessions: Number(e.group_sessions ?? 0),
    rateExceptions: Number(e.rate_exceptions ?? 0),
    importWarnings: Number(e.import_warnings ?? 0),
    unresolvedRowCount: Number(e.unresolved_rows ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Individuals budget board (the register list)                               */
/* -------------------------------------------------------------------------- */

export interface IndividualBudgetSummary {
  status: UtilizationStatus;
  usedPct: number | null; // 0–100, total billed ÷ total authorized (period-scoped)
  elapsedPct: number | null; // 0–100
  renews: string | null; // period end / renewal date
  hoursLeft: number | null; // authorized − billed
  plans: number; // active authorizations in the period
}

export interface IndividualBudgetBoardRow {
  id: string;
  name: string;
  preferredName: string | null;
  status: string;
  archived: boolean;
  programs: string[];
  budget: IndividualBudgetSummary | null;
}

const BUDGET_SEVERITY: Record<UtilizationStatus, number> = {
  over_authorization: 0,
  fully_used: 1,
  near_exhaustion: 2,
  behind_pace: 3,
  ahead_of_pace: 4,
  on_pace: 5,
  not_started: 6,
};

/**
 * The Individuals register, as a budget board. Health, % used, remaining and
 * renewal come from the SAME engine the detail page uses: authorized hours from
 * budget_authorizations, billed hours from payroll_transactions.imported_hours
 * within the current period (windowed on Period Begin). So the badge here and the
 * badge on the detail page can never disagree, and both reconcile to the ledger.
 */
export async function listIndividualBudgetBoard(
  pool: PgLikePool,
  asOf: Date = new Date(),
): Promise<IndividualBudgetBoardRow[]> {
  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    preferred_name: string | null;
    status: string;
    archived_at: string | null;
    start_date: string | null;
    end_date: string | null;
    renewal_date: string | null;
    program_name: string | null;
    authorized_hours: string | null;
    billed_hours: string | null;
  }>(
    `SELECT i.id, i.display_name, i.preferred_name, i.status,
            i.archived_at::text AS archived_at,
            l.start_date::text  AS start_date,
            l.end_date::text    AS end_date,
            l.renewal_date::text AS renewal_date,
            p.name              AS program_name,
            b.authorized_hours::text AS authorized_hours,
            COALESCE(bill.hrs, 0)::text AS billed_hours
       FROM individuals i
       LEFT JOIN LATERAL (
         SELECT bp.id, bp.start_date, bp.end_date, bp.renewal_date
           FROM budget_periods bp
          WHERE bp.individual_id = i.id
          ORDER BY bp.start_date DESC
          LIMIT 1
       ) l ON true
       LEFT JOIN budget_authorizations b
              ON b.budget_period_id = l.id AND b.status = 'active'
       LEFT JOIN programs p ON p.id = b.program_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(t.imported_hours), 0) AS hrs
           FROM payroll_transactions t
          WHERE t.individual_id = i.id
            AND t.program_id = b.program_id
            AND t.period_begin >= l.start_date
            AND t.period_begin <= l.end_date
       ) bill ON b.id IS NOT NULL
      WHERE i.merged_into_id IS NULL
      ORDER BY i.display_name`,
  );

  type Acc = {
    id: string;
    name: string;
    preferredName: string | null;
    status: string;
    archived: boolean;
    period: { start: string; end: string; renewal: string | null } | null;
    programs: Set<string>;
    auths: { code: string; authorized: string; billed: string }[];
  };
  const byId = new Map<string, Acc>();
  for (const r of rows) {
    let acc = byId.get(r.id);
    if (!acc) {
      acc = {
        id: r.id,
        name: r.display_name,
        preferredName: r.preferred_name,
        status: r.status,
        archived: r.status === "archived" || r.archived_at !== null,
        period: r.start_date && r.end_date ? { start: r.start_date, end: r.end_date, renewal: r.renewal_date } : null,
        programs: new Set<string>(),
        auths: [],
      };
      byId.set(r.id, acc);
    }
    if (r.program_name && r.authorized_hours !== null) {
      acc.programs.add(r.program_name);
      acc.auths.push({ code: r.program_name, authorized: r.authorized_hours, billed: r.billed_hours ?? "0" });
    }
  }

  const out: IndividualBudgetBoardRow[] = [];
  for (const acc of byId.values()) {
    let budget: IndividualBudgetSummary | null = null;
    if (acc.period && acc.auths.length > 0) {
      const elapsed = calculatePeriodElapsed({ startDate: acc.period.start, endDate: acc.period.end }, asOf);
      let totalAuth = dec(0);
      let totalBilled = dec(0);
      let worst: UtilizationStatus = "not_started";
      for (const a of acc.auths) {
        const auth = dec(a.authorized);
        const billed = dec(a.billed);
        totalAuth = totalAuth.plus(auth);
        totalBilled = totalBilled.plus(billed);
        const usage = auth.isZero() ? dec(0) : billed.dividedBy(auth);
        const st = classifyUtilization(usage, elapsed);
        if (BUDGET_SEVERITY[st] < BUDGET_SEVERITY[worst]) worst = st;
      }
      const usedPct = totalAuth.isZero() ? null : totalBilled.dividedBy(totalAuth).times(100).toNumber();
      budget = {
        status: worst,
        usedPct,
        elapsedPct: dec(elapsed.timeElapsedPercent).times(100).toNumber(),
        renews: acc.period.renewal ?? acc.period.end,
        hoursLeft: totalAuth.minus(totalBilled).toNumber(),
        plans: acc.auths.length,
      };
    }
    out.push({
      id: acc.id,
      name: acc.name,
      preferredName: acc.preferredName,
      status: acc.status,
      archived: acc.archived,
      programs: [...acc.programs].sort(),
      budget,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Employees                                                                  */
/* -------------------------------------------------------------------------- */

export interface EmployeeReport {
  employee: { id: string; displayName: string };
  /** Hours the employee was actually present. Group sessions counted ONCE. */
  physicalHours: string;
  /** Billed hours (sum of imported_hours across the ledger); reconciles to the
   *  Transactions grid filtered to this employee. Exceeds physical on groups. */
  allocationHours: string;
  individualsServed: number;
  programs: string[];
  groupSessions: number;
  agencyGross: string;
  internalAmount: string;
  rateExceptions: number;
}

/**
 * Physical hours and allocation hours are two different quantities and are
 * never merged. A 13-hour session with three individuals is 13 physical hours
 * and 39 allocation hours; reporting 39 as "hours worked" would overstate the
 * employee's time by 200%.
 */
export async function getEmployeeReport(
  pool: PgLikePool,
  employeeId: string,
): Promise<EmployeeReport | null> {
  const { rows: people } = await pool.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM employees WHERE id = $1`,
    [employeeId],
  );
  if (!people[0]) return null;

  const { rows } = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT coalesce(sum(s.physical_hours), 0)
          FROM service_sessions s WHERE s.employee_id = $1)::text          AS physical_hours,
       (SELECT coalesce(sum(t.imported_hours), 0)
          FROM payroll_transactions t WHERE t.employee_id = $1)::text       AS allocation_hours,
       (SELECT count(DISTINCT t.individual_id)
          FROM payroll_transactions t WHERE t.employee_id = $1)::text      AS individuals_served,
       (SELECT count(*) FROM service_sessions s
         WHERE s.employee_id = $1 AND s.group_size > 1)::text              AS group_sessions,
       (SELECT coalesce(sum(t.imported_amount), 0)
          FROM payroll_transactions t WHERE t.employee_id = $1)::text      AS agency_gross,
       (SELECT coalesce(sum(t.calculated_internal_amount), 0)
          FROM payroll_transactions t WHERE t.employee_id = $1)::text      AS internal_amount,
       (SELECT count(*) FROM rate_exceptions x
          JOIN payroll_transactions t ON t.id = x.payroll_transaction_id
         WHERE t.employee_id = $1)::text                                   AS rate_exceptions`,
    [employeeId],
  );
  const r = rows[0] ?? {};

  const { rows: programs } = await pool.query<{ name: string }>(
    `SELECT DISTINCT p.name
       FROM payroll_transactions t JOIN programs p ON p.id = t.program_id
      WHERE t.employee_id = $1
      ORDER BY p.name`,
    [employeeId],
  );

  return {
    employee: { id: people[0].id, displayName: people[0].display_name },
    physicalHours: toHours(r.physical_hours ?? "0"),
    allocationHours: toHours(r.allocation_hours ?? "0"),
    individualsServed: Number(r.individuals_served ?? 0),
    programs: programs.map((p) => p.name),
    groupSessions: Number(r.group_sessions ?? 0),
    agencyGross: toMoney(r.agency_gross ?? "0"),
    internalAmount: toMoney(r.internal_amount ?? "0"),
    rateExceptions: Number(r.rate_exceptions ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Exceptions                                                                 */
/* -------------------------------------------------------------------------- */

export interface ExceptionCounts {
  unknownPrograms: number;
  unmatchedNames: number;
  pendingAliases: number;
  rateExceptions: number;
  duplicateCandidates: number;
  groupReviewIssues: number;
  reconciliationDifferences: number;
  overAuthorization: number;
}

export async function exceptionCounts(pool: PgLikePool): Promise<ExceptionCounts> {
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM import_warnings WHERE category = 'unknown_program')::text          AS unknown_programs,
       (SELECT count(*) FROM import_warnings
         WHERE category IN ('unmatched_individual','unmatched_employee','ambiguous_name'))::text AS unmatched_names,
       ((SELECT count(*) FROM individual_aliases WHERE status = 'pending')
        + (SELECT count(*) FROM employee_aliases WHERE status = 'pending'))::text               AS pending_aliases,
       (SELECT count(*) FROM rate_exceptions WHERE resolution = 'open')::text                   AS rate_exceptions,
       (SELECT count(*) FROM import_warnings WHERE category = 'possible_duplicate')::text       AS duplicate_candidates,
       (SELECT count(*) FROM service_sessions
         WHERE group_detection_status = 'needs_review')::text                                   AS group_review_issues,
       (SELECT count(*) FROM import_batches
         WHERE reconciliation_notes IS NOT NULL
           AND reconciliation_notes LIKE '%DO NOT agree%')::text                                AS reconciliation_differences,
       (SELECT count(*) FROM (
          SELECT b.id
            FROM budget_authorizations b
            LEFT JOIN payroll_transactions t ON t.individual_id = b.individual_id
                                            AND t.program_id = b.program_id
            LEFT JOIN service_allocations a ON a.payroll_transaction_id = t.id
           GROUP BY b.id, b.authorized_hours
          HAVING coalesce(sum(a.allocation_hours), 0) > b.authorized_hours
       ) AS over_auth)::text                                                                    AS over_authorization`,
  );
  const r = rows[0] ?? {};
  return {
    unknownPrograms: Number(r.unknown_programs ?? 0),
    unmatchedNames: Number(r.unmatched_names ?? 0),
    pendingAliases: Number(r.pending_aliases ?? 0),
    rateExceptions: Number(r.rate_exceptions ?? 0),
    duplicateCandidates: Number(r.duplicate_candidates ?? 0),
    groupReviewIssues: Number(r.group_review_issues ?? 0),
    reconciliationDifferences: Number(r.reconciliation_differences ?? 0),
    overAuthorization: Number(r.over_authorization ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function sumField<K extends string>(rows: Record<K, string>[], field: K): string {
  return toMoney(rows.reduce((sum, r) => sum.plus(dec(r[field])), dec(0)));
}

/** Stand-in for an individual with transactions but no configured period. */
function notStartedElapsed(): PeriodElapsed {
  return {
    totalDays: 0,
    elapsedDays: 0,
    remainingDays: 0,
    timeElapsedPercent: "0.000000",
    hasStarted: false,
    hasEnded: false,
  };
}
