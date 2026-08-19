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
import { derivePeriodFromRenewal, currentBudgetPeriod } from "@/lib/business/calculation-strategy";
import {
  type BudgetLineStatus,
  BUDGET_STATUS_RANK,
  budgetStatusFromHours,
} from "@/lib/business/budget-status";

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
  status: UtilizationStatus; // pace vocabulary (kept for the pace bar colour)
  plainStatus: BudgetLineStatus; // plain amount vocabulary, matches the profile
  usedPct: number | null; // 0–100, total billed ÷ total authorized (period-scoped)
  elapsedPct: number | null; // 0–100
  renews: string | null; // period end / renewal date
  hoursLeft: number | null; // authorized − billed
  plans: number; // programs in the plan
  daysToRenewal: number | null; // renews − today (negative = expired)
  expired: boolean; // the period end is in the past
  mustUseWeekly: number | null; // hours to use per week to finish by renewal
}

export interface IndividualBudgetBoardRow {
  id: string;
  name: string;
  preferredName: string | null;
  status: string;
  archived: boolean;
  programs: string[];
  budget: IndividualBudgetSummary | null;
  /** Has committed transactions — used to flag "billing but no budget on file". */
  hasBilling: boolean;
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
 * renewal come from the SAME plan the profile and the Financial page use:
 * authorized hours from the Calculations-tab plan (calculation_strategy_lines),
 * billed hours from payroll_transactions.imported_hours inside the current
 * renewal year (renewal − 12 months → renewal). One source, so the list here can
 * never disagree with a person's own page, and both reconcile to the ledger.
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
    renewal_date: string | null;
    program_name: string | null;
    authorized_hours: string | null;
    billed_hours: string | null;
    has_billing: boolean;
  }>(
    `WITH plan AS (
       SELECT DISTINCT ON (cs.individual_id)
              cs.individual_id, cs.id AS strategy_id,
              -- The renewal auto-rolls forward for ACTIVE accounts: the current
              -- year ends on the first anniversary on/after today. Inactive
              -- accounts keep the stored (possibly past) date.
              (CASE WHEN i.status = 'active' AND cs.renewal_date <= CURRENT_DATE
                    THEN (cs.renewal_date + make_interval(years => extract(year from age(CURRENT_DATE, cs.renewal_date))::int + 1))::date
                    ELSE cs.renewal_date END) AS period_end
         FROM calculation_strategies cs
         JOIN individuals i ON i.id = cs.individual_id
        WHERE cs.status = 'active' AND cs.renewal_date IS NOT NULL
        ORDER BY cs.individual_id, cs.created_at
     )
     SELECT i.id, i.display_name, i.preferred_name, i.status,
            i.archived_at::text AS archived_at,
            to_char(pl.period_end, 'YYYY-MM-DD') AS renewal_date,
            pr.name                  AS program_name,
            l.authorized_hours::text AS authorized_hours,
            COALESCE(b.hrs, 0)::text AS billed_hours,
            EXISTS (SELECT 1 FROM payroll_transactions t WHERE t.individual_id = i.id) AS has_billing
       FROM individuals i
       LEFT JOIN plan pl ON pl.individual_id = i.id
       LEFT JOIN calculation_strategy_lines l ON l.strategy_id = pl.strategy_id
       LEFT JOIN programs pr ON pr.id = l.program_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(t.imported_hours), 0) AS hrs
           FROM payroll_transactions t
          WHERE t.individual_id = i.id
            AND t.program_id = l.program_id
            AND t.period_begin >= (pl.period_end - interval '1 year')
            AND t.period_begin <= pl.period_end
       ) b ON l.id IS NOT NULL
      WHERE i.merged_into_id IS NULL
      ORDER BY i.display_name`,
  );

  type Acc = {
    id: string;
    name: string;
    preferredName: string | null;
    status: string;
    archived: boolean;
    renewal: string | null;
    programs: Set<string>;
    auths: { authorized: string; billed: string }[];
    hasBilling: boolean;
  };
  const byId = new Map<string, Acc>();
  const today = asOf.toISOString().slice(0, 10);
  for (const r of rows) {
    let acc = byId.get(r.id);
    if (!acc) {
      acc = {
        id: r.id,
        name: r.display_name,
        preferredName: r.preferred_name,
        status: r.status,
        archived: r.status === "archived" || r.archived_at !== null,
        renewal: r.renewal_date,
        programs: new Set<string>(),
        auths: [],
        hasBilling: r.has_billing === true,
      };
      byId.set(r.id, acc);
    }
    if (r.program_name && r.authorized_hours !== null) {
      acc.programs.add(r.program_name);
      acc.auths.push({ authorized: r.authorized_hours, billed: r.billed_hours ?? "0" });
    }
  }

  const out: IndividualBudgetBoardRow[] = [];
  for (const acc of byId.values()) {
    let budget: IndividualBudgetSummary | null = null;
    const period = derivePeriodFromRenewal(acc.renewal);
    if (acc.renewal && acc.auths.length > 0) {
      const elapsed =
        period.start && period.end ? calculatePeriodElapsed({ startDate: period.start, endDate: period.end }, asOf) : null;
      let totalAuth = dec(0);
      let totalBilled = dec(0);
      let worst: UtilizationStatus = "not_started";
      for (const a of acc.auths) {
        const auth = dec(a.authorized);
        const billed = dec(a.billed);
        totalAuth = totalAuth.plus(auth);
        totalBilled = totalBilled.plus(billed);
        if (elapsed) {
          const usage = auth.isZero() ? dec(0) : billed.dividedBy(auth);
          const st = classifyUtilization(usage, elapsed);
          if (BUDGET_SEVERITY[st] < BUDGET_SEVERITY[worst]) worst = st;
        }
      }
      const usedPct = totalAuth.isZero() ? null : totalBilled.dividedBy(totalAuth).times(100).toNumber();
      const dayMs = 24 * 60 * 60 * 1000;
      const daysToRenewal = Math.round((Date.parse(`${acc.renewal}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / dayMs);
      const hoursLeft = totalAuth.minus(totalBilled).toNumber();
      const weeksLeft = daysToRenewal > 0 ? daysToRenewal / 7 : 0;
      budget = {
        status: worst,
        plainStatus: budgetStatusFromHours(totalAuth.toNumber(), totalBilled.toNumber()),
        usedPct,
        elapsedPct: elapsed ? dec(elapsed.timeElapsedPercent).times(100).toNumber() : null,
        renews: acc.renewal,
        hoursLeft,
        plans: acc.auths.length,
        daysToRenewal,
        expired: daysToRenewal < 0,
        mustUseWeekly: weeksLeft > 0 && hoursLeft > 0 ? hoursLeft / weeksLeft : null,
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
      hasBilling: acc.hasBilling,
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
  duplicateIndividuals: number;
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
         WHERE category IN ('unmatched_individual','unmatched_employee','ambiguous_name')
           AND severity IN ('warning','error'))::text                                          AS unmatched_names,
       (SELECT count(*) FROM individual_match_reviews WHERE status = 'pending')::text          AS duplicate_individuals,
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
    duplicateIndividuals: Number(r.duplicate_individuals ?? 0),
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

/* -------------------------------------------------------------------------- */
/* Individual budget — ONE plain-language view of "where are we up to".        */
/*                                                                            */
/* This is the single source the individual profile leads with. Authorized   */
/* hours come from the Calculations-tab plan (calculation_strategy_lines);    */
/* used hours are the real billed transactions inside the current 12-month    */
/* period; remaining and status fall straight out of the two. Financial and   */
/* the Individuals board read the same plan, so nothing can disagree.         */
/* -------------------------------------------------------------------------- */

export type { BudgetLineStatus };

export interface BudgetLine {
  programId: string;
  programName: string;
  programCode: string;
  authorizedHours: string; // from the plan; "0" for billed-but-not-planned
  perHour: string; // the plan's per-hour rate for this program (override or default)
  usedHours: string; // billed inside the period
  remainingHours: string; // authorized − used
  usagePercent: number | null; // 0..>1
  status: BudgetLineStatus;
  agencyBilled: string; // $ billed this period for this program
  internalBilled: string;
  txCount: number;
  inPlan: boolean;
}

export interface IndividualBudgetView {
  hasPlan: boolean;
  strategyId: string | null; // the plan to edit (null until one is created)
  active: boolean; // account is active (renewal auto-rolls); inactive can read expired
  renewalDate: string | null; // stored anniversary (what the editor edits)
  effectiveRenewal: string | null; // rolled forward to the current year for active accounts
  periodStart: string | null;
  periodEnd: string | null;
  daysToRenewal: number | null;
  expired: boolean;
  timeElapsedPercent: number | null; // 0..100, for the pace marker
  lines: BudgetLine[];
  totals: { authorizedHours: string; usedHours: string; remainingHours: string; usagePercent: number | null };
  money: { agencyBilled: string; internalBilled: string; txCount: number };
  headline: BudgetLineStatus | null; // worst line, for the one-glance answer
}

const budgetLineStatus = (authorized: ReturnType<typeof dec>, used: ReturnType<typeof dec>): BudgetLineStatus =>
  budgetStatusFromHours(authorized.toNumber(), used.toNumber());

export async function getIndividualBudgetView(pool: PgLikePool, individualId: string): Promise<IndividualBudgetView> {
  // The individual's account status decides whether the renewal auto-rolls.
  const indRes = await pool.query<{ status: string }>(`SELECT status FROM individuals WHERE id = $1`, [individualId]);
  const active = (indRes.rows[0]?.status ?? "active") === "active";

  // The individual's active plan (usually one) and its renewal date.
  const planRes = await pool.query<{ id: string; renewal_date: string | null }>(
    `SELECT id, to_char(renewal_date, 'YYYY-MM-DD') AS renewal_date
       FROM calculation_strategies
      WHERE individual_id = $1 AND status = 'active'
      ORDER BY created_at
      LIMIT 1`,
    [individualId],
  );
  const plan = planRes.rows[0] ?? null;
  const renewalDate = plan?.renewal_date ?? null;
  // Auto-rolls to the current year for active accounts; stays put for inactive.
  const period = currentBudgetPeriod(renewalDate, active);
  const effectiveRenewal = period.effectiveRenewal;

  // Authorized hours (and any per-hour rate override) per program from the plan.
  const authRows = plan
    ? (
        await pool.query<{ program_id: string; program_name: string; program_code: string; authorized_hours: string; rate_override: string | null }>(
          `SELECT l.program_id, p.name AS program_name, p.code AS program_code,
                  l.authorized_hours::text AS authorized_hours, l.rate_override::text AS rate_override
             FROM calculation_strategy_lines l
             JOIN programs p ON p.id = l.program_id
            WHERE l.strategy_id = $1`,
          [plan.id],
        )
      ).rows
    : [];

  // The default per-hour rate per program (latest schedule), so a line with no
  // override still shows the rate it will bill at.
  const rateRows = (
    await pool.query<{ program_id: string; internal_rate: string }>(
      `SELECT DISTINCT ON (program_id) program_id, internal_rate::text AS internal_rate
         FROM program_rate_schedules
        ORDER BY program_id, effective_from DESC`,
    )
  ).rows;
  const defaultRateByProgram = new Map(rateRows.map((r) => [r.program_id, r.internal_rate]));

  // Billed inside the current period, per program (the real "used").
  const billedRows =
    period.start && period.end
      ? (
          await pool.query<{ program_id: string; program_name: string; program_code: string; hours: string; agency: string; internal: string; cnt: number }>(
            `SELECT t.program_id, p.name AS program_name, p.code AS program_code,
                    sum(t.imported_hours)::text AS hours,
                    sum(t.imported_amount)::text AS agency,
                    sum(COALESCE(t.calculated_internal_amount, t.spreadsheet_internal_amount,
                             t.internal_rate_applied * t.imported_hours, 0))::text AS internal,
                    count(*)::int AS cnt
               FROM payroll_transactions t
               JOIN programs p ON p.id = t.program_id
              WHERE t.individual_id = $1 AND t.program_id IS NOT NULL
                AND t.period_begin >= $2 AND t.period_begin <= $3
              GROUP BY t.program_id, p.name, p.code`,
            [individualId, period.start, period.end],
          )
        ).rows
      : [];

  const billedByProgram = new Map(billedRows.map((r) => [r.program_id, r]));
  const authByProgram = new Map(authRows.map((r) => [r.program_id, r]));
  const allProgramIds = new Set<string>([...authByProgram.keys(), ...billedByProgram.keys()]);

  let totAuth = dec(0), totUsed = dec(0), totAgency = dec(0), totInternal = dec(0), totTx = 0;
  let headline: BudgetLineStatus | null = null;
  const lines: BudgetLine[] = [];
  for (const pid of allProgramIds) {
    const a = authByProgram.get(pid);
    const b = billedByProgram.get(pid);
    const authorized = dec(a?.authorized_hours ?? 0);
    const used = dec(b?.hours ?? 0);
    const remaining = authorized.minus(used);
    const status = budgetLineStatus(authorized, used);
    const usagePercent = authorized.greaterThan(0) ? used.dividedBy(authorized).toNumber() : null;
    // Budget totals reflect the PLAN only, so "used of authorized" matches the
    // per-program table. Money counts every billed row in the period.
    if (a) {
      totAuth = totAuth.plus(authorized);
      totUsed = totUsed.plus(used);
      if (headline === null || BUDGET_STATUS_RANK[status] > BUDGET_STATUS_RANK[headline]) headline = status;
    }
    totAgency = totAgency.plus(dec(b?.agency ?? 0));
    totInternal = totInternal.plus(dec(b?.internal ?? 0));
    totTx += b?.cnt ?? 0;
    const perHour = a?.rate_override ?? defaultRateByProgram.get(pid) ?? "0";
    lines.push({
      programId: pid,
      programName: a?.program_name ?? b?.program_name ?? "Unknown program",
      programCode: a?.program_code ?? b?.program_code ?? "",
      authorizedHours: toHours(authorized),
      perHour: toMoney(dec(perHour)),
      usedHours: toHours(used),
      remainingHours: toHours(remaining),
      usagePercent,
      status,
      agencyBilled: toMoney(dec(b?.agency ?? 0)),
      internalBilled: toMoney(dec(b?.internal ?? 0)),
      txCount: b?.cnt ?? 0,
      inPlan: !!a,
    });
  }
  // Planned lines first (biggest authorization first), then billed-not-planned.
  lines.sort((x, y) => {
    if (x.inPlan !== y.inPlan) return x.inPlan ? -1 : 1;
    return dec(y.authorizedHours).minus(dec(x.authorizedHours)).toNumber();
  });

  // Days to the (rolled) renewal and how far the current year has elapsed.
  let daysToRenewal: number | null = null;
  let expired = false;
  let timeElapsedPercent: number | null = null;
  if (effectiveRenewal) {
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    daysToRenewal = Math.round((Date.parse(`${effectiveRenewal}T00:00:00Z`) - todayUtc) / dayMs);
    // Active accounts always roll forward, so "expired" only applies to inactive ones.
    expired = !active && daysToRenewal < 0;
    if (period.start && period.end) {
      const start = Date.parse(`${period.start}T00:00:00Z`);
      const end = Date.parse(`${period.end}T00:00:00Z`);
      if (end > start) timeElapsedPercent = Math.max(0, Math.min(100, ((todayUtc - start) / (end - start)) * 100));
    }
  }

  return {
    hasPlan: !!plan && authRows.length > 0,
    strategyId: plan?.id ?? null,
    active,
    renewalDate,
    effectiveRenewal,
    periodStart: period.start,
    periodEnd: period.end,
    daysToRenewal,
    expired,
    timeElapsedPercent,
    lines,
    totals: {
      authorizedHours: toHours(totAuth),
      usedHours: toHours(totUsed),
      remainingHours: toHours(totAuth.minus(totUsed)),
      usagePercent: totAuth.greaterThan(0) ? totUsed.dividedBy(totAuth).toNumber() : null,
    },
    money: { agencyBilled: toMoney(totAgency), internalBilled: toMoney(totInternal), txCount: totTx },
    headline,
  };
}

/* -------------------------------------------------------------------------- */
/* Individual period activity — this budget year's billing, on the profile.    */
/*                                                                            */
/* So a coordinator never has to leave the page to see "what was billed this  */
/* period": one query breaks it down by month (for plan-vs-actual pacing) and  */
/* one by employee (who did the work). Both windowed to the current 12-month   */
/* budget period, never the whole history.                                     */
/* -------------------------------------------------------------------------- */

export interface PeriodMonth {
  month: string; // YYYY-MM
  hours: string;
  agency: string;
  internal: string;
}
export interface PeriodEmployee {
  id: string | null;
  name: string;
  hours: string;
  agency: string;
  internal: string;
  txCount: number;
}
export interface IndividualPeriodActivity {
  byMonth: PeriodMonth[];
  byEmployee: PeriodEmployee[];
}

export async function getIndividualPeriodActivity(
  pool: PgLikePool,
  individualId: string,
  start: string | null,
  end: string | null,
  planProgramIds?: string[] | null,
): Promise<IndividualPeriodActivity> {
  if (!start || !end) return { byMonth: [], byEmployee: [] };
  const internalExpr =
    "COALESCE(t.calculated_internal_amount, t.spreadsheet_internal_amount, t.internal_rate_applied * t.imported_hours, 0)";
  // The monthly bars are compared against the budget's even monthly target
  // (authorized ÷ 12), so they must count the SAME programs the budget authorizes
  // — otherwise billed-but-not-planned programs inflate the bars above a target
  // that never covered them. When a plan scope is given we filter to it; with no
  // scope (no plan) we fall back to all of the individual's billed hours.
  const scoped = Array.isArray(planProgramIds) && planProgramIds.length > 0;
  const monthRes = await pool.query<{ month: string; hours: string; agency: string; internal: string }>(
    `SELECT to_char(date_trunc('month', t.period_begin), 'YYYY-MM') AS month,
            sum(t.imported_hours)::text  AS hours,
            sum(t.imported_amount)::text AS agency,
            sum(${internalExpr})::text   AS internal
       FROM payroll_transactions t
      WHERE t.individual_id = $1 AND t.period_begin >= $2 AND t.period_begin <= $3
        ${scoped ? "AND t.program_id = ANY($4::uuid[])" : ""}
      GROUP BY 1
      ORDER BY 1`,
    scoped ? [individualId, start, end, planProgramIds] : [individualId, start, end],
  );
  const empRes = await pool.query<{ id: string | null; name: string; hours: string; agency: string; internal: string; tx: number }>(
    `SELECT t.employee_id AS id,
            COALESCE(e.display_name, t.employee_raw, 'Unknown') AS name,
            sum(t.imported_hours)::text  AS hours,
            sum(t.imported_amount)::text AS agency,
            sum(${internalExpr})::text   AS internal,
            count(*)::int                AS tx
       FROM payroll_transactions t
       LEFT JOIN employees e ON e.id = t.employee_id
      WHERE t.individual_id = $1 AND t.period_begin >= $2 AND t.period_begin <= $3
      GROUP BY t.employee_id, e.display_name, t.employee_raw
      ORDER BY sum(t.imported_hours) DESC`,
    [individualId, start, end],
  );
  return {
    byMonth: monthRes.rows.map((r) => ({ month: r.month, hours: r.hours, agency: r.agency, internal: r.internal })),
    byEmployee: empRes.rows.map((r) => ({ id: r.id, name: r.name, hours: r.hours, agency: r.agency, internal: r.internal, txCount: r.tx })),
  };
}
