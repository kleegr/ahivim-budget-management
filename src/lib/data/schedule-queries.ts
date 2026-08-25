import type { PgLikePool } from "@/lib/import/commit";
import { toMoney, toHours, dec } from "@/lib/money";
import {
  calculatePeriodElapsed,
  classifyUtilization,
  type PeriodElapsed,
  type UtilizationStatus,
} from "@/lib/business/utilization";

type ScheduleQueryPool = Pick<PgLikePool, "query">;

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

function nextIsoDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

const LIVE_WARNING_CODES = new Set([
  "employee_double_booked",
  "individual_double_booked",
  "individual_two_employees_one_to_one",
  "over_authorized_hours",
  "not_assigned",
  "missing_authorization",
  "outside_authorization_dates",
  "ambiguous_authorization",
]);

function plannerWarnings(value: unknown): Array<{ code?: unknown }> {
  if (!Array.isArray(value)) return [];
  return (value as Array<{ code?: unknown }>).filter((warning) => {
    const code = typeof warning?.code === "string" ? warning.code : "";
    return code !== "missing_rate" && !LIVE_WARNING_CODES.has(code);
  });
}

/** Elapsed placeholder for classification when an individual has no budget period. */
const NOT_STARTED_ELAPSED: PeriodElapsed = {
  totalDays: 0,
  elapsedDays: 0,
  remainingDays: 0,
  timeElapsedPercent: "0.000000",
  hasStarted: false,
  hasEnded: false,
};

export interface CalendarSession {
  id: string;
  seriesId: string | null;
  sessionDate: string;
  startTime: string | null;
  endTime: string | null;
  durationHours: string;
  employeeId: string | null;
  employeeName: string | null;
  programId: string;
  programName: string;
  isGroup: boolean;
  groupSize: number;
  individualNames: string[];
  individualIds: string[];
  status: string;
  warningCount: number;
  canChangeSchedule: boolean;
}

export interface CalendarFilter {
  from: string;
  to: string;
  employeeId?: string;
  individualId?: string;
  programId?: string;
  unassigned?: boolean;
  status?: string;
}

/** Planned sessions in a date range. This calendar DTO is intentionally hours-only. */
export async function listSessions(pool: PgLikePool, filter: CalendarFilter): Promise<CalendarSession[]> {
  const employeeId = filter.employeeId && isUuid(filter.employeeId) ? filter.employeeId : null;
  const individualId = filter.individualId && isUuid(filter.individualId) ? filter.individualId : null;
  const programId = filter.programId && isUuid(filter.programId) ? filter.programId : null;
  const status = ["pending", "completed", "cancelled", "no_show"].includes(filter.status ?? "") ? filter.status! : null;

  const { rows } = await pool.query<{
    id: string; series_id: string | null; session_date: string; start_time: string | null;
    end_time: string | null; duration_hours: string; employee_id: string | null; employee_name: string | null;
    program_id: string; program_name: string; is_group: boolean; group_size: number; status: string;
    warnings: unknown; can_change_schedule: boolean;
    individual_names: string[] | null; individual_ids: string[] | null;
  }>(
    `SELECT s.id, s.series_id, s.session_date::text, s.start_time, s.end_time,
            s.duration_hours::text, s.employee_id, e.display_name AS employee_name,
            s.program_id, p.name AS program_name, s.is_group, s.group_size,
            CASE
              WHEN s.status = 'pending' AND s.matched_transaction_id IS NOT NULL THEN 'completed'
              ELSE s.status
            END AS status,
            (s.matched_transaction_id IS NULL) AS can_change_schedule,
            s.warnings,
            array_agg(i.display_name ORDER BY i.display_name) AS individual_names,
            array_agg(a.individual_id::text) AS individual_ids
     FROM scheduled_sessions s
     LEFT JOIN employees e ON e.id = s.employee_id
     JOIN programs p ON p.id = s.program_id
     LEFT JOIN scheduled_allocations a ON a.scheduled_session_id = s.id
     LEFT JOIN individuals i ON i.id = a.individual_id
     WHERE s.session_date BETWEEN $1 AND $2
       AND ($3::uuid IS NULL OR s.employee_id = $3)
       AND ($4::uuid IS NULL OR s.program_id = $4)
       AND ($5::boolean IS NOT TRUE OR s.employee_id IS NULL)
       AND ($6::text IS NULL OR CASE
             WHEN s.status = 'pending' AND s.matched_transaction_id IS NOT NULL THEN 'completed'
             ELSE s.status
           END = $6)
       AND (
         $6::text IS NOT NULL
         OR s.status <> 'cancelled'
         OR NOT EXISTS (
           SELECT 1
           FROM schedule_series successor
           WHERE successor.supersedes_series_id = s.series_id
             AND successor.archived_at IS NULL
             AND s.session_date >= successor.start_date
         )
       )
       AND ($7::uuid IS NULL OR EXISTS (
             SELECT 1 FROM scheduled_allocations aa WHERE aa.scheduled_session_id = s.id AND aa.individual_id = $7))
     GROUP BY s.id, e.display_name, p.name
     ORDER BY s.session_date, s.start_time NULLS LAST`,
    [filter.from, filter.to, employeeId, programId, filter.unassigned ?? false, status, individualId],
  );

  return rows.map((r) => ({
    id: r.id,
    seriesId: r.series_id,
    sessionDate: r.session_date,
    startTime: r.start_time,
    endTime: r.end_time,
    durationHours: r.duration_hours,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    programId: r.program_id,
    programName: r.program_name,
    isGroup: r.is_group,
    groupSize: r.group_size,
    individualNames: (r.individual_names ?? []).filter(Boolean),
    individualIds: (r.individual_ids ?? []).filter(Boolean),
    status: r.status,
    warningCount: plannerWarnings(r.warnings).length,
    canChangeSchedule: r.can_change_schedule,
  }));
}

export async function getSession(pool: PgLikePool, id: string): Promise<CalendarSession | null> {
  if (!isUuid(id)) return null;
  const rows = await listSessionsById(pool, id);
  return rows[0] ?? null;
}
async function listSessionsById(pool: PgLikePool, id: string): Promise<CalendarSession[]> {
  const { rows } = await pool.query<{ session_date: string }>(
    `SELECT session_date::text FROM scheduled_sessions WHERE id = $1`,
    [id],
  );
  if (!rows[0]) return [];
  const all = await listSessions(pool, { from: rows[0].session_date, to: rows[0].session_date });
  const session = all.find((item) => item.id === id);
  if (!session) return [];
  const flags = await listSessionWarningFlags(pool, {
    from: rows[0].session_date,
    to: rows[0].session_date,
  });
  const warningCount = flags.find((item) => item.id === id)?.warningCount;
  return [{ ...session, warningCount: warningCount ?? session.warningCount }];
}

/** Scheduled (pending) hours and expected internal per program, for one individual. */
export async function scheduledByProgramForIndividual(
  pool: PgLikePool,
  individualId: string,
): Promise<Record<string, { hours: string; internal: string }>> {
  if (!isUuid(individualId)) return {};
  const { rows } = await pool.query<{ code: string; hours: string; internal: string }>(
    `SELECT p.code,
            COALESCE(sum(a.allocation_hours),0)::text AS hours,
            COALESCE(sum(a.allocated_amount),0)::text AS internal
     FROM scheduled_allocations a
     JOIN scheduled_sessions s ON s.id = a.scheduled_session_id
     JOIN programs p ON p.id = s.program_id
     WHERE a.individual_id = $1 AND s.status = 'pending'
       AND s.matched_transaction_id IS NULL
     GROUP BY p.code`,
    [individualId],
  );
  const out: Record<string, { hours: string; internal: string }> = {};
  for (const r of rows) out[r.code] = { hours: toHours(r.hours), internal: toMoney(r.internal) };
  return out;
}

/** Portfolio scheduled totals (pending) for the dashboard. */
export async function scheduledTotals(pool: PgLikePool): Promise<{ hours: string; internal: string; sessions: number; unbilled: number }> {
  const { rows } = await pool.query<{ hours: string; internal: string; sessions: string; unbilled: string }>(
    `SELECT COALESCE(sum(s.duration_hours),0)::text AS hours,
            COALESCE(sum(s.expected_internal_amount),0)::text AS internal,
            count(*)::text AS sessions,
            count(*) FILTER (WHERE s.matched_transaction_id IS NULL)::text AS unbilled
     FROM scheduled_sessions s
     WHERE s.status = 'pending' AND s.matched_transaction_id IS NULL`,
  );
  const r = rows[0]!;
  return { hours: toHours(r.hours), internal: toMoney(r.internal), sessions: Number(r.sessions), unbilled: Number(r.unbilled) };
}

export interface ProgramForecast {
  authorizedHours: string | null;
  authStart: string | null;
  authEnd: string | null;
  actualHours: string;
  actualAmount: string;
  scheduledHours: string;
  scheduledAmount: string;
  remainingAfterScheduleHours: string | null;
  authorizationCount: number;
  authorizationAmbiguous: boolean;
  authorizations: Array<{
    authorizationId: string;
    periodId: string;
    periodLabel: string;
    startDate: string;
    endDate: string;
    authorizedHours: string;
  }>;
}

interface EffectiveAuthorizationRow {
  authorization_id: string;
  period_id: string;
  period_label: string;
  program_id: string;
  program_code: string;
  program_name: string;
  start_date: string;
  end_date: string;
  authorized_hours: string;
  internal_rate: string;
  is_explicit: boolean;
}

interface AuthorizationUsage {
  actualHours: string;
  actualAmount: string;
  scheduledHours: string;
  scheduledAmount: string;
}

async function activeAuthorizations(
  pool: ScheduleQueryPool,
  individualId: string,
  asOfDate: string,
  programId?: string,
): Promise<EffectiveAuthorizationRow[]> {
  const { rows } = await pool.query<EffectiveAuthorizationRow>(
    `SELECT ea.authorization_id::text, ea.period_id::text, ea.period_label,
            ea.program_id::text, p.code AS program_code, p.name AS program_name,
            ea.start_date::text, ea.end_date::text, ea.authorized_hours::text,
            ea.internal_rate::text,
            EXISTS (
              SELECT 1 FROM budget_authorizations ba
               WHERE ba.id = ea.authorization_id
            ) AS is_explicit
       FROM effective_budget_authorizations_at($2::date) ea
       JOIN programs p ON p.id = ea.program_id
      WHERE ea.individual_id = $1
        AND ($3::uuid IS NULL OR ea.program_id = $3)
      ORDER BY p.name, ea.start_date, ea.end_date, ea.authorization_id`,
    [individualId, asOfDate, programId ?? null],
  );
  return rows;
}

async function authorizationUsage(
  pool: ScheduleQueryPool,
  individualId: string,
  authorization: EffectiveAuthorizationRow,
  excludeSessionId?: string | null,
): Promise<AuthorizationUsage> {
  const actual = authorization.is_explicit
    ? await pool.query<{ h: string; amt: string }>(
        `SELECT COALESCE(sum(al.allocation_hours),0)::text AS h,
                COALESCE(sum(al.allocated_amount),0)::text AS amt
           FROM service_allocations al
           JOIN service_sessions ss ON ss.id = al.service_session_id
          WHERE al.individual_id = $1 AND ss.program_id = $2
            AND COALESCE(ss.period_begin, ss.period_end) BETWEEN $3::date AND $4::date`,
        [individualId, authorization.program_id, authorization.start_date, authorization.end_date],
      )
    : await pool.query<{ h: string; amt: string }>(
        `SELECT effective_billed_hours($1, $2, $3::date, $4::date, $5::numeric)::text AS h,
                COALESCE((
                  SELECT sum(COALESCE(
                    t.calculated_internal_amount,
                    t.spreadsheet_internal_amount,
                    t.internal_rate_applied * t.imported_hours,
                    0
                  ))
                    FROM payroll_transactions t
                   WHERE t.individual_id = $1 AND t.program_id = $2
                     AND t.period_begin BETWEEN $3::date AND $4::date
                ), 0)::text AS amt`,
        [
          individualId,
          authorization.program_id,
          authorization.start_date,
          authorization.end_date,
          authorization.internal_rate,
        ],
      );
  const scheduled = await pool.query<{ h: string; amt: string }>(
    `SELECT COALESCE(sum(sa.allocation_hours),0)::text AS h,
            COALESCE(sum(sa.allocated_amount),0)::text AS amt
       FROM scheduled_allocations sa
       JOIN scheduled_sessions s ON s.id = sa.scheduled_session_id
      WHERE sa.individual_id = $1 AND s.program_id = $2 AND s.status = 'pending'
        AND s.matched_transaction_id IS NULL
        AND s.session_date BETWEEN $3::date AND $4::date
        AND ($5::uuid IS NULL OR s.id <> $5)`,
    [
      individualId,
      authorization.program_id,
      authorization.start_date,
      authorization.end_date,
      excludeSessionId ?? null,
    ],
  );

  return {
    actualHours: actual.rows[0]?.h ?? "0",
    actualAmount: actual.rows[0]?.amt ?? "0",
    scheduledHours: scheduled.rows[0]?.h ?? "0",
    scheduledAmount: scheduled.rows[0]?.amt ?? "0",
  };
}

/**
 * The three-part picture for one individual on one program:
 *   actual billed (already imported) / scheduled but not billed (pending) /
 *   what authorised hours would remain once the schedule is honoured.
 * `excludeSessionId` drops one pending session from the scheduled total, so an
 * edit preview does not count the session against itself.
 * Every figure is contained to the authorization that covers `asOfDate`.
 */
export async function individualProgramForecast(
  pool: ScheduleQueryPool,
  individualId: string,
  programId: string,
  excludeSessionId?: string | null,
  asOfDate: string = new Date().toISOString().slice(0, 10),
): Promise<ProgramForecast> {
  const empty: ProgramForecast = {
    authorizedHours: null, authStart: null, authEnd: null,
    actualHours: toHours("0"), actualAmount: toMoney("0"),
    scheduledHours: toHours("0"), scheduledAmount: toMoney("0"),
    remainingAfterScheduleHours: null,
    authorizationCount: 0,
    authorizationAmbiguous: false,
    authorizations: [],
  };
  if (!isUuid(individualId) || !isUuid(programId)) return empty;

  const authorizations = await activeAuthorizations(pool, individualId, asOfDate, programId);
  if (authorizations.length === 0) return empty;

  const publicAuthorizations = authorizations.map((authorization) => ({
    authorizationId: authorization.authorization_id,
    periodId: authorization.period_id,
    periodLabel: authorization.period_label,
    startDate: authorization.start_date,
    endDate: authorization.end_date,
    authorizedHours: toHours(authorization.authorized_hours),
  }));
  const first = authorizations[0]!;
  const safelyCombined = authorizations.every((authorization) =>
    authorization.start_date === first.start_date
      && authorization.end_date === first.end_date
      && authorization.internal_rate === first.internal_rate
      && authorization.is_explicit === first.is_explicit);
  if (!safelyCombined) {
    return {
      ...empty,
      authorizationCount: authorizations.length,
      authorizationAmbiguous: true,
      authorizations: publicAuthorizations,
    };
  }

  const usage = await authorizationUsage(pool, individualId, first, excludeSessionId);
  const authorizedHours = authorizations.reduce(
    (total, authorization) => total.plus(authorization.authorized_hours),
    dec(0),
  );
  const actualHours = usage.actualHours;
  const scheduledHours = usage.scheduledHours;
  const remaining = authorizedHours.minus(dec(actualHours)).minus(dec(scheduledHours));

  return {
    authorizedHours: toHours(authorizedHours),
    authStart: first.start_date,
    authEnd: first.end_date,
    actualHours: toHours(actualHours),
    actualAmount: toMoney(usage.actualAmount),
    scheduledHours: toHours(scheduledHours),
    scheduledAmount: toMoney(usage.scheduledAmount),
    remainingAfterScheduleHours: toHours(remaining),
    authorizationCount: authorizations.length,
    authorizationAmbiguous: false,
    authorizations: publicAuthorizations,
  };
}

/* ===========================================================================
 * ADDITIVE: utilisation summary for the schedule planner strip.
 *
 * Keeps every active authorization and evaluates each against its own period.
 * Totals use an authorized-hours-weighted clock when programs are distinct;
 * same-program overlaps stay separate and suppress unsafe combined figures.
 * ========================================================================= */
export interface ScheduleUtilizationProgram {
  authorizationId: string;
  periodId: string;
  programId: string;
  programCode: string;
  programName: string;
  periodLabel: string;
  startDate: string;
  endDate: string;
  renewalDate: string;
  timeElapsedPercent: string;
  daysRemaining: number;
  requiredWeeklyHours: string | null;
  authorizationAmbiguous: boolean;
  authorizedHours: string | null;
  usedHours: string;
  scheduledHours: string;
  remainingAfterHours: string | null;
  /** used / authorized, as a decimal fraction (matches PaceBar/UtilizationBadge). */
  usagePercent: string;
  /** (used + scheduled) / authorized, as a decimal fraction. */
  committedPercent: string;
  status: UtilizationStatus;
}

export interface ScheduleUtilizationSummary {
  individualId: string;
  individualName: string;
  hasAuthorization: boolean;
  period: { label: string; startDate: string; endDate: string; renewalDate: string | null } | null;
  periodCount: number;
  /** Authorized-hours-weighted elapsed fraction; null when totals are ambiguous. */
  timeElapsedPercent: string | null;
  /** Whole days to period end, only when every authorization uses one period. */
  daysRemaining: number | null;
  requiredWeeklyHours: string | null;
  totalsAmbiguous: boolean;
  ambiguityMessage: string | null;
  authorizedHours: string | null;
  usedHours: string | null;
  scheduledHours: string | null;
  /** authorized − used − scheduled: the hours still available AND unplanned. */
  remainingAfterHours: string | null;
  usagePercent: string | null;
  committedPercent: string | null;
  status: UtilizationStatus | null;
  programs: ScheduleUtilizationProgram[];
}

export async function individualScheduleSummary(
  pool: PgLikePool,
  individualId: string,
  asOf: Date = new Date(),
): Promise<ScheduleUtilizationSummary | null> {
  if (!isUuid(individualId)) return null;
  const asOfDate = asOf.toISOString().slice(0, 10);
  const person = await pool.query<{ display_name: string }>(
    `SELECT display_name FROM individuals WHERE id = $1`,
    [individualId],
  );
  if (!person.rows[0]) return null;

  const authorizationRows = await activeAuthorizations(pool, individualId, asOfDate);
  const programCounts = new Map<string, number>();
  for (const row of authorizationRows) {
    programCounts.set(row.program_id, (programCounts.get(row.program_id) ?? 0) + 1);
  }
  const ambiguousProgramNames = [...new Set(
    authorizationRows
      .filter((row) => (programCounts.get(row.program_id) ?? 0) > 1)
      .map((row) => row.program_name),
  )];
  const totalsAmbiguous = ambiguousProgramNames.length > 0;

  let totalAuth = dec(0);
  let totalUsed = dec(0);
  let totalSched = dec(0);
  let weightedElapsed = dec(0);
  let totalRequiredWeekly = dec(0);
  const programs: ScheduleUtilizationProgram[] = [];

  for (const authorization of authorizationRows) {
    const facts = await authorizationUsage(pool, individualId, authorization);
    const auth = dec(authorization.authorized_hours);
    const used = dec(facts.actualHours);
    const sched = dec(facts.scheduledHours);
    const elapsed = calculatePeriodElapsed(
      { startDate: authorization.start_date, endDate: authorization.end_date },
      asOf,
    );
    const remaining = auth.minus(used).minus(sched);
    const usage = auth.isZero() ? dec(0) : used.dividedBy(auth);
    const committed = auth.isZero() ? dec(0) : used.plus(sched).dividedBy(auth);
    const requiredWeekly = elapsed.remainingDays > 0 && remaining.gt(0)
      ? remaining.times(7).dividedBy(elapsed.remainingDays)
      : null;

    if (!totalsAmbiguous) {
      totalAuth = totalAuth.plus(auth);
      totalUsed = totalUsed.plus(used);
      totalSched = totalSched.plus(sched);
      weightedElapsed = weightedElapsed.plus(auth.times(elapsed.timeElapsedPercent));
      if (requiredWeekly) totalRequiredWeekly = totalRequiredWeekly.plus(requiredWeekly);
    }
    programs.push({
      authorizationId: authorization.authorization_id,
      periodId: authorization.period_id,
      programId: authorization.program_id,
      programCode: authorization.program_code,
      programName: authorization.program_name,
      periodLabel: authorization.period_label,
      startDate: authorization.start_date,
      endDate: authorization.end_date,
      renewalDate: nextIsoDate(authorization.end_date),
      timeElapsedPercent: elapsed.timeElapsedPercent,
      daysRemaining: elapsed.remainingDays,
      requiredWeeklyHours: requiredWeekly ? toHours(requiredWeekly) : null,
      authorizationAmbiguous: (programCounts.get(authorization.program_id) ?? 0) > 1,
      authorizedHours: toHours(auth),
      usedHours: toHours(used),
      scheduledHours: toHours(sched),
      remainingAfterHours: toHours(remaining),
      usagePercent: usage.toFixed(6),
      committedPercent: committed.toFixed(6),
      status: classifyUtilization(usage, elapsed),
    });
  }

  const periodRows = new Map<string, EffectiveAuthorizationRow>();
  for (const row of authorizationRows) periodRows.set(`${row.start_date}:${row.end_date}`, row);
  const sharedPeriod = periodRows.size === 1 ? [...periodRows.values()][0]! : null;
  const sharedLabels = new Set(authorizationRows.map((row) => row.period_label));
  const aggregateElapsedPercent = totalAuth.isZero()
    ? dec(0)
    : weightedElapsed.dividedBy(totalAuth);
  const remainingAfter = totalAuth.minus(totalUsed).minus(totalSched);
  const usagePercent = totalAuth.isZero() ? dec(0) : totalUsed.dividedBy(totalAuth);
  const committedPercent = totalAuth.isZero() ? dec(0) : totalUsed.plus(totalSched).dividedBy(totalAuth);
  const aggregateElapsed: PeriodElapsed = {
    ...NOT_STARTED_ELAPSED,
    timeElapsedPercent: aggregateElapsedPercent.toFixed(6),
    hasStarted: authorizationRows.length > 0,
  };
  const sharedElapsed = sharedPeriod
    ? calculatePeriodElapsed({ startDate: sharedPeriod.start_date, endDate: sharedPeriod.end_date }, asOf)
    : null;
  const ambiguityMessage = totalsAmbiguous
    ? `Multiple active authorizations overlap for ${ambiguousProgramNames.join(", ")}. Combined totals are hidden because used and scheduled hours cannot be assigned safely between them.`
    : null;

  return {
    individualId,
    individualName: person.rows[0].display_name,
    hasAuthorization: authorizationRows.length > 0,
    period: sharedPeriod
      ? {
          label: sharedLabels.size === 1 ? sharedPeriod.period_label : "Shared authorization period",
          startDate: sharedPeriod.start_date,
          endDate: sharedPeriod.end_date,
          renewalDate: nextIsoDate(sharedPeriod.end_date),
        }
      : null,
    periodCount: periodRows.size,
    timeElapsedPercent: totalsAmbiguous ? null : aggregateElapsedPercent.toFixed(6),
    daysRemaining: totalsAmbiguous ? null : sharedElapsed?.remainingDays ?? null,
    requiredWeeklyHours: totalsAmbiguous ? null : toHours(totalRequiredWeekly),
    totalsAmbiguous,
    ambiguityMessage,
    authorizedHours: totalsAmbiguous ? null : toHours(totalAuth),
    usedHours: totalsAmbiguous ? null : toHours(totalUsed),
    scheduledHours: totalsAmbiguous ? null : toHours(totalSched),
    remainingAfterHours: totalsAmbiguous ? null : toHours(remainingAfter),
    usagePercent: totalsAmbiguous ? null : usagePercent.toFixed(6),
    committedPercent: totalsAmbiguous ? null : committedPercent.toFixed(6),
    status: totalsAmbiguous ? null : classifyUtilization(usagePercent, aggregateElapsed),
    programs,
  };
}

export interface SessionWarningFlags {
  id: string;
  hasConflict: boolean;
  hasBudgetRisk: boolean;
  warningCount: number;
}

export async function listSessionWarningFlags(
  pool: PgLikePool,
  filter: CalendarFilter,
): Promise<SessionWarningFlags[]> {
  const employeeId = filter.employeeId && isUuid(filter.employeeId) ? filter.employeeId : null;
  const individualId = filter.individualId && isUuid(filter.individualId) ? filter.individualId : null;
  const programId = filter.programId && isUuid(filter.programId) ? filter.programId : null;
  const status = ["pending", "completed", "cancelled", "no_show"].includes(filter.status ?? "") ? filter.status! : null;

  const { rows } = await pool.query<{
    id: string;
    warnings: unknown;
    has_conflict: boolean;
    has_budget_risk: boolean;
    has_assignment_gap: boolean;
  }>(
    `SELECT s.id, s.warnings,
            (
              s.status IN ('pending', 'completed')
              AND (
                (
                  s.employee_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                    FROM scheduled_sessions other
                    WHERE other.id <> s.id
                      AND other.employee_id = s.employee_id
                      AND other.session_date = s.session_date
                      AND other.status IN ('pending', 'completed')
                      AND (
                        s.start_time IS NULL OR s.end_time IS NULL
                        OR other.start_time IS NULL OR other.end_time IS NULL
                        OR (s.start_time < other.end_time AND other.start_time < s.end_time)
                      )
                  )
                )
                OR EXISTS (
                  SELECT 1
                  FROM scheduled_allocations target
                  JOIN scheduled_allocations other_a
                    ON other_a.individual_id = target.individual_id
                  JOIN scheduled_sessions other
                    ON other.id = other_a.scheduled_session_id
                  WHERE target.scheduled_session_id = s.id
                    AND other.id <> s.id
                    AND other.session_date = s.session_date
                    AND other.status IN ('pending', 'completed')
                    AND (
                      s.start_time IS NULL OR s.end_time IS NULL
                      OR other.start_time IS NULL OR other.end_time IS NULL
                      OR (s.start_time < other.end_time AND other.start_time < s.end_time)
                    )
                )
              )
            ) AS has_conflict,
            (
              s.status = 'pending' AND s.matched_transaction_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM scheduled_allocations target
                WHERE target.scheduled_session_id = s.id
                  AND (
                    (
                      SELECT count(*)
                      FROM effective_budget_authorizations_at(s.session_date) ea
                      WHERE ea.individual_id = target.individual_id
                        AND ea.program_id = s.program_id
                    ) > 1
                    OR NOT EXISTS (
                      SELECT 1
                      FROM effective_budget_authorizations_at(s.session_date) ea
                      WHERE ea.individual_id = target.individual_id
                        AND ea.program_id = s.program_id
                    )
                    OR EXISTS (
                      SELECT 1
                      FROM effective_budget_authorizations_at(s.session_date) ea
                      WHERE ea.individual_id = target.individual_id
                        AND ea.program_id = s.program_id
                        AND (
                          CASE
                            WHEN EXISTS (
                              SELECT 1 FROM budget_authorizations explicit_auth
                               WHERE explicit_auth.id = ea.authorization_id
                            ) THEN COALESCE((
                              SELECT sum(actual_a.allocation_hours)
                              FROM service_allocations actual_a
                              JOIN service_sessions actual_s ON actual_s.id = actual_a.service_session_id
                              WHERE actual_a.individual_id = target.individual_id
                                AND actual_s.program_id = s.program_id
                                AND COALESCE(actual_s.period_begin, actual_s.period_end)
                                    BETWEEN ea.start_date AND ea.end_date
                            ), 0)
                            ELSE effective_billed_hours(
                              target.individual_id, s.program_id,
                              ea.start_date, ea.end_date, ea.internal_rate
                            )
                          END
                          + COALESCE((
                            SELECT sum(planned_a.allocation_hours)
                            FROM scheduled_allocations planned_a
                            JOIN scheduled_sessions planned_s ON planned_s.id = planned_a.scheduled_session_id
                            WHERE planned_a.individual_id = target.individual_id
                              AND planned_s.program_id = s.program_id
                              AND planned_s.status = 'pending'
                              AND planned_s.matched_transaction_id IS NULL
                              AND planned_s.session_date BETWEEN ea.start_date AND ea.end_date
                          ), 0)
                        ) > ea.authorized_hours
                    )
                  )
              )
            ) AS has_budget_risk,
            (
              s.status = 'pending' AND s.matched_transaction_id IS NULL AND s.employee_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM scheduled_allocations target
                WHERE target.scheduled_session_id = s.id
                  AND NOT EXISTS (
                    SELECT 1
                    FROM assignments assignment
                    WHERE assignment.employee_id = s.employee_id
                      AND assignment.individual_id = target.individual_id
                      AND assignment.status = 'active' AND assignment.archived_at IS NULL
                      AND (assignment.program_id IS NULL OR assignment.program_id = s.program_id)
                      AND (assignment.start_date IS NULL OR assignment.start_date <= s.session_date)
                      AND (assignment.end_date IS NULL OR assignment.end_date >= s.session_date)
                  )
              )
            ) AS has_assignment_gap
     FROM scheduled_sessions s
     WHERE s.session_date BETWEEN $1 AND $2
       AND ($3::uuid IS NULL OR s.employee_id = $3)
       AND ($4::uuid IS NULL OR s.program_id = $4)
       AND ($5::boolean IS NOT TRUE OR s.employee_id IS NULL)
       AND ($6::text IS NULL OR CASE
             WHEN s.status = 'pending' AND s.matched_transaction_id IS NOT NULL THEN 'completed'
             ELSE s.status
           END = $6)
       AND (
         $6::text IS NOT NULL
         OR s.status <> 'cancelled'
         OR NOT EXISTS (
           SELECT 1
           FROM schedule_series successor
           WHERE successor.supersedes_series_id = s.series_id
             AND successor.archived_at IS NULL
             AND s.session_date >= successor.start_date
         )
       )
       AND ($7::uuid IS NULL OR EXISTS (
             SELECT 1 FROM scheduled_allocations aa WHERE aa.scheduled_session_id = s.id AND aa.individual_id = $7))`,
    [filter.from, filter.to, employeeId, programId, filter.unassigned ?? false, status, individualId],
  );

  return rows.map((r) => {
    const staticWarningCount = plannerWarnings(r.warnings).length;
    const liveWarningCount = Number(r.has_conflict) + Number(r.has_budget_risk) + Number(r.has_assignment_gap);
    return {
      id: r.id,
      hasConflict: r.has_conflict,
      hasBudgetRisk: r.has_budget_risk,
      warningCount: staticWarningCount + liveWarningCount,
    };
  });
}

export async function listSeriesForEmployee(pool: PgLikePool, employeeId: string) {
  if (!isUuid(employeeId)) return [];
  const { rows } = await pool.query<{
    id: string; frequency: string; interval: number; start_date: string; end_date: string; status: string;
    program_name: string | null; occurrences: string;
  }>(
    `SELECT ss.id, ss.frequency, ss.interval, ss.start_date::text, ss.end_date::text, ss.status,
            p.name AS program_name,
            (SELECT count(*)::text FROM scheduled_sessions x WHERE x.series_id = ss.id) AS occurrences
     FROM schedule_series ss LEFT JOIN programs p ON p.id = ss.program_id
     WHERE ss.employee_id = $1 ORDER BY ss.start_date DESC`,
    [employeeId],
  );
  return rows.map((r) => ({
    id: r.id, frequency: r.frequency, interval: r.interval, startDate: r.start_date, endDate: r.end_date,
    status: r.status, programName: r.program_name, occurrences: Number(r.occurrences),
  }));
}
