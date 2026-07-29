import type { PgLikePool } from "@/lib/import/commit";
import { toMoney, toHours, dec } from "@/lib/money";

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

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
 */
export async function individualProgramForecast(
  pool: PgLikePool,
  individualId: string,
  programId: string,
  excludeSessionId?: string | null,
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
     ORDER BY bp.start_date DESC LIMIT 1`,
    [individualId, programId],
  );
  const actual = await pool.query<{ h: string; amt: string }>(
    `SELECT COALESCE(sum(al.allocation_hours),0)::text AS h,
            COALESCE(sum(al.allocated_amount),0)::text AS amt
     FROM service_allocations al JOIN service_sessions ss ON ss.id = al.service_session_id
     WHERE al.individual_id = $1 AND ss.program_id = $2`,
    [individualId, programId],
  );
  const scheduled = await pool.query<{ h: string; amt: string }>(
    `SELECT COALESCE(sum(sa.allocation_hours),0)::text AS h,
            COALESCE(sum(sa.allocated_amount),0)::text AS amt
     FROM scheduled_allocations sa JOIN scheduled_sessions s ON s.id = sa.scheduled_session_id
     WHERE sa.individual_id = $1 AND s.program_id = $2 AND s.status = 'pending'
       AND ($3::uuid IS NULL OR s.id <> $3)`,
    [individualId, programId, excludeSessionId ?? null],
  );

  const authorizedHours = auth.rows[0]?.authorized_hours ?? null;
  const actualHours = actual.rows[0]?.h ?? "0";
  const scheduledHours = scheduled.rows[0]?.h ?? "0";
  const remaining =
    authorizedHours === null
      ? null
      : dec(authorizedHours).minus(dec(actualHours)).minus(dec(scheduledHours));

  return {
    authorizedHours: authorizedHours === null ? null : toHours(authorizedHours),
    authStart: auth.rows[0]?.start_date ?? null,
    authEnd: auth.rows[0]?.end_date ?? null,
    actualHours: toHours(actualHours),
    actualAmount: toMoney(actual.rows[0]?.amt ?? "0"),
    scheduledHours: toHours(scheduledHours),
    scheduledAmount: toMoney(scheduled.rows[0]?.amt ?? "0"),
    remainingAfterScheduleHours: remaining === null ? null : toHours(remaining),
  };
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
