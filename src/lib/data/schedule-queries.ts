import type { PgLikePool } from "@/lib/import/commit";
import { toMoney, toHours, dec } from "@/lib/money";
import {
  calculatePeriodElapsed,
  classifyUtilization,
  type PeriodElapsed,
  type UtilizationStatus,
} from "@/lib/business/utilization";

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

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
  expectedAgencyGross: string | null;
  expectedInternalAmount: string | null;
  warningCount: number;
  reconciliationStatus: string | null;
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

/** Planned sessions in a date range, with the people and expected billing. */
export async function listSessions(pool: PgLikePool, filter: CalendarFilter): Promise<CalendarSession[]> {
  const employeeId = filter.employeeId && isUuid(filter.employeeId) ? filter.employeeId : null;
  const individualId = filter.individualId && isUuid(filter.individualId) ? filter.individualId : null;
  const programId = filter.programId && isUuid(filter.programId) ? filter.programId : null;
  const status = ["pending", "completed", "cancelled", "no_show"].includes(filter.status ?? "") ? filter.status! : null;

  const { rows } = await pool.query<{
    id: string; series_id: string | null; session_date: string; start_time: string | null;
    end_time: string | null; duration_hours: string; employee_id: string | null; employee_name: string | null;
    program_id: string; program_name: string; is_group: boolean; group_size: number; status: string;
    expected_agency_gross: string | null; expected_internal_amount: string | null;
    warnings: unknown; reconciliation_status: string | null;
    individual_names: string[] | null; individual_ids: string[] | null;
  }>(
    `SELECT s.id, s.series_id, s.session_date::text, s.start_time, s.end_time,
            s.duration_hours::text, s.employee_id, e.display_name AS employee_name,
            s.program_id, p.name AS program_name, s.is_group, s.group_size, s.status,
            s.expected_agency_gross::text, s.expected_internal_amount::text,
            s.warnings, s.reconciliation_status,
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
       AND ($6::text IS NULL OR s.status = $6)
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
    expectedAgencyGross: r.expected_agency_gross,
    expectedInternalAmount: r.expected_internal_amount,
    warningCount: Array.isArray(r.warnings) ? r.warnings.length : 0,
    reconciliationStatus: r.reconciliation_status,
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
  return all.filter((s) => s.id === id);
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
     FROM scheduled_sessions s WHERE s.status = 'pending'`,
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
  pool: PgLikePool,
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
  };
  if (!isUuid(individualId) || !isUuid(programId)) return empty;

  const auth = await pool.query<{ authorized_hours: string; start_date: string; end_date: string }>(
    `SELECT ba.authorized_hours::text, bp.start_date::text AS start_date, bp.end_date::text AS end_date
     FROM budget_authorizations ba JOIN budget_periods bp ON bp.id = ba.budget_period_id
     WHERE ba.individual_id = $1 AND ba.program_id = $2 AND ba.status = 'active' AND bp.status = 'active'
       AND $3::date BETWEEN bp.start_date AND bp.end_date
     ORDER BY bp.start_date DESC, ba.revision DESC LIMIT 1`,
    [individualId, programId, asOfDate],
  );
  const selected = auth.rows[0];
  if (!selected) return empty;

  const actual = await pool.query<{ h: string; amt: string }>(
    `SELECT COALESCE(sum(al.allocation_hours),0)::text AS h,
            COALESCE(sum(al.allocated_amount),0)::text AS amt
     FROM service_allocations al JOIN service_sessions ss ON ss.id = al.service_session_id
     WHERE al.individual_id = $1 AND ss.program_id = $2
       AND COALESCE(ss.period_begin, ss.period_end) BETWEEN $3::date AND $4::date`,
    [individualId, programId, selected.start_date, selected.end_date],
  );
  const scheduled = await pool.query<{ h: string; amt: string }>(
    `SELECT COALESCE(sum(sa.allocation_hours),0)::text AS h,
            COALESCE(sum(sa.allocated_amount),0)::text AS amt
     FROM scheduled_allocations sa JOIN scheduled_sessions s ON s.id = sa.scheduled_session_id
     WHERE sa.individual_id = $1 AND s.program_id = $2 AND s.status = 'pending'
       AND s.session_date BETWEEN $3::date AND $4::date
       AND ($5::uuid IS NULL OR s.id <> $5)`,
    [individualId, programId, selected.start_date, selected.end_date, excludeSessionId ?? null],
  );

  const authorizedHours = selected.authorized_hours;
  const actualHours = actual.rows[0]?.h ?? "0";
  const scheduledHours = scheduled.rows[0]?.h ?? "0";
  const remaining =
    authorizedHours === null
      ? null
      : dec(authorizedHours).minus(dec(actualHours)).minus(dec(scheduledHours));

  return {
    authorizedHours: authorizedHours === null ? null : toHours(authorizedHours),
    authStart: selected.start_date,
    authEnd: selected.end_date,
    actualHours: toHours(actualHours),
    actualAmount: toMoney(actual.rows[0]?.amt ?? "0"),
    scheduledHours: toHours(scheduledHours),
    scheduledAmount: toMoney(scheduled.rows[0]?.amt ?? "0"),
    remainingAfterScheduleHours: remaining === null ? null : toHours(remaining),
  };
}

/* ===========================================================================
 * ADDITIVE: utilisation summary for the schedule planner strip.
 *
 * Aggregates the schedule domain's own view of authorised / used / scheduled /
 * remaining-after-schedule hours across every active authorisation for one
 * individual, plus the pace (used vs time elapsed) against their current budget
 * period. Reuses individualProgramForecast so the figures match the modal
 * preview and the individual-detail page exactly; nothing here re-derives the
 * money/billing maths.
 * ========================================================================= */
export interface ScheduleUtilizationProgram {
  programId: string;
  programCode: string;
  programName: string;
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
  /** Fraction of the budget period elapsed; "0" when there is no active period. */
  timeElapsedPercent: string;
  /** Whole days from today to the period end; null when there is no active period. */
  daysRemaining: number | null;
  authorizedHours: string;
  usedHours: string;
  scheduledHours: string;
  /** authorized − used − scheduled: the hours still available AND unplanned. */
  remainingAfterHours: string;
  usagePercent: string;
  committedPercent: string;
  status: UtilizationStatus;
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

  // The current active budget period drives pace and renewal messaging.
  const periodRes = await pool.query<{
    label: string; start_date: string; end_date: string; renewal_date: string | null;
  }>(
    `SELECT label, start_date::text AS start_date, end_date::text AS end_date,
            renewal_date::text AS renewal_date
     FROM budget_periods
     WHERE individual_id = $1 AND status = 'active'
       AND $2::date BETWEEN start_date AND end_date
     ORDER BY start_date DESC LIMIT 1`,
    [individualId, asOfDate],
  );
  const periodRow = periodRes.rows[0] ?? null;
  const elapsed = periodRow
    ? calculatePeriodElapsed({ startDate: periodRow.start_date, endDate: periodRow.end_date }, asOf)
    : null;

  // Programs this individual has an active authorisation for.
  const progRes = await pool.query<{ id: string; code: string; name: string }>(
    `SELECT DISTINCT p.id, p.code, p.name
     FROM budget_authorizations ba
     JOIN budget_periods bp ON bp.id = ba.budget_period_id
     JOIN programs p ON p.id = ba.program_id
     WHERE ba.individual_id = $1 AND ba.status = 'active' AND bp.status = 'active'
       AND $2::date BETWEEN bp.start_date AND bp.end_date
     ORDER BY p.name`,
    [individualId, asOfDate],
  );

  let totalAuth = dec(0);
  let totalUsed = dec(0);
  let totalSched = dec(0);
  let hasAuthorization = false;
  const programs: ScheduleUtilizationProgram[] = [];

  for (const p of progRes.rows) {
    const f = await individualProgramForecast(pool, individualId, p.id, null, asOfDate);
    const auth = f.authorizedHours === null ? null : dec(f.authorizedHours);
    const used = dec(f.actualHours);
    const sched = dec(f.scheduledHours);
    if (auth !== null) {
      hasAuthorization = true;
      totalAuth = totalAuth.plus(auth);
    }
    totalUsed = totalUsed.plus(used);
    totalSched = totalSched.plus(sched);
    const usage = auth && !auth.isZero() ? used.dividedBy(auth) : dec(0);
    const committed = auth && !auth.isZero() ? used.plus(sched).dividedBy(auth) : dec(0);
    programs.push({
      programId: p.id,
      programCode: p.code,
      programName: p.name,
      authorizedHours: f.authorizedHours,
      usedHours: f.actualHours,
      scheduledHours: f.scheduledHours,
      remainingAfterHours: f.remainingAfterScheduleHours,
      usagePercent: usage.toFixed(6),
      committedPercent: committed.toFixed(6),
      status: classifyUtilization(usage, elapsed ?? NOT_STARTED_ELAPSED),
    });
  }

  const remainingAfter = totalAuth.minus(totalUsed).minus(totalSched);
  const usagePercent = totalAuth.isZero() ? dec(0) : totalUsed.dividedBy(totalAuth);
  const committedPercent = totalAuth.isZero() ? dec(0) : totalUsed.plus(totalSched).dividedBy(totalAuth);

  let daysRemaining: number | null = null;
  if (periodRow) {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const todayUtc = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
    daysRemaining = Math.round(
      (new Date(`${periodRow.end_date}T00:00:00Z`).getTime() - todayUtc) / MS_PER_DAY,
    );
  }

  return {
    individualId,
    individualName: person.rows[0].display_name,
    hasAuthorization,
    period: periodRow
      ? { label: periodRow.label, startDate: periodRow.start_date, endDate: periodRow.end_date, renewalDate: periodRow.renewal_date }
      : null,
    timeElapsedPercent: elapsed ? elapsed.timeElapsedPercent : "0",
    daysRemaining,
    authorizedHours: toHours(totalAuth),
    usedHours: toHours(totalUsed),
    scheduledHours: toHours(totalSched),
    remainingAfterHours: toHours(remainingAfter),
    usagePercent: usagePercent.toFixed(6),
    committedPercent: committedPercent.toFixed(6),
    status: classifyUtilization(usagePercent, elapsed ?? NOT_STARTED_ELAPSED),
    programs,
  };
}

/* ===========================================================================
 * ADDITIVE: per-session warning classification for colour-coding calendar
 * events. Reads the warnings JSON already stored on each planned session (set
 * by detectConflicts at save time) and buckets the codes into "conflict" vs
 * "budget/authorisation risk" so the calendar can colour them distinctly
 * without changing listSessions. Same filter shape as listSessions.
 *
 * NB: the code buckets below mirror classifyWarningCode() in
 * components/schedule/shared.tsx, which does the same job for the live preview
 * warnings in the create-session modal.
 * ========================================================================= */
const CONFLICT_WARNING_CODES = new Set([
  "employee_double_booked",
  "individual_double_booked",
  "individual_two_employees_one_to_one",
  "program_not_group",
  "group_over_max",
]);
const BUDGET_WARNING_CODES = new Set([
  "over_authorized_hours",
  "missing_authorization",
  "outside_authorization_dates",
]);

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

  const { rows } = await pool.query<{ id: string; warnings: unknown }>(
    `SELECT s.id, s.warnings
     FROM scheduled_sessions s
     WHERE s.session_date BETWEEN $1 AND $2
       AND ($3::uuid IS NULL OR s.employee_id = $3)
       AND ($4::uuid IS NULL OR s.program_id = $4)
       AND ($5::boolean IS NOT TRUE OR s.employee_id IS NULL)
       AND ($6::text IS NULL OR s.status = $6)
       AND ($7::uuid IS NULL OR EXISTS (
             SELECT 1 FROM scheduled_allocations aa WHERE aa.scheduled_session_id = s.id AND aa.individual_id = $7))`,
    [filter.from, filter.to, employeeId, programId, filter.unassigned ?? false, status, individualId],
  );

  return rows.map((r) => {
    const arr = Array.isArray(r.warnings) ? (r.warnings as Array<{ code?: unknown }>) : [];
    let hasConflict = false;
    let hasBudgetRisk = false;
    for (const w of arr) {
      const code = typeof w?.code === "string" ? w.code : "";
      if (BUDGET_WARNING_CODES.has(code)) hasBudgetRisk = true;
      else if (CONFLICT_WARNING_CODES.has(code)) hasConflict = true;
    }
    return { id: r.id, hasConflict, hasBudgetRisk, warningCount: arr.length };
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
