import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { dec, toHours } from "@/lib/money";
import {
  expectedBilling, durationBetween, timesOverlap, generateOccurrences,
} from "@/lib/business/scheduling";
import { resolveEffectiveRate } from "@/lib/business/rate-resolver";
import { individualProgramForecast } from "@/lib/data/schedule-queries";

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

export interface ScheduleWarning {
  code: string;
  severity: "warning" | "error";
  message: string;
}

/** The rate in force for a program on a date, via the one effective-dated resolver. */
export async function currentRate(
  pool: PgLikePool,
  programId: string,
  onDate: string,
): Promise<{ agencyRate: string | null; internalRate: string } | null> {
  const { rows } = await pool.query<{
    agency_rate: string | null;
    internal_rate: string;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT agency_rate::text    AS agency_rate,
            internal_rate::text  AS internal_rate,
            effective_from::text AS effective_from,
            effective_to::text   AS effective_to
       FROM program_rate_schedules
      WHERE program_id = $1 AND archived_at IS NULL`,
    [programId],
  );
  return resolveEffectiveRate(
    rows.map((r) => ({
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      agencyRate: r.agency_rate,
      internalRate: r.internal_rate,
    })),
    onDate,
  );
}

export interface SessionDraft {
  employeeId: string | null;
  programId: string;
  individualIds: string[];
  sessionDate: string;
  startTime: string | null;
  endTime: string | null;
  durationHours: string;
}

/**
 * Every reason a planned session might warrant a second look. None of these
 * BLOCK — an authorised user can save anyway with a written reason — but each
 * is surfaced and stored so nothing slips through silently.
 */
export async function detectConflicts(
  pool: PgLikePool,
  draft: SessionDraft,
  excludeSessionId?: string,
): Promise<ScheduleWarning[]> {
  const w: ScheduleWarning[] = [];
  const hours = dec(draft.durationHours);
  const isGroup = draft.individualIds.length > 1;

  // Program active + rate present, plus its configurable operational rules.
  const prog = await pool.query<{
    is_active: boolean; name: string; groups_allowed: boolean; one_to_one_required: boolean;
    max_group_size: number | null; allow_multiple_employees: boolean;
  }>(
    `SELECT is_active, name, groups_allowed, one_to_one_required, max_group_size, allow_multiple_employees
     FROM programs WHERE id = $1`,
    [draft.programId],
  );
  const rules = prog.rows[0];
  if (!rules) w.push({ code: "program_missing", severity: "error", message: "The program does not exist." });
  else if (!rules.is_active) w.push({ code: "program_inactive", severity: "warning", message: `Program ${rules.name} is inactive.` });
  const rate = await currentRate(pool, draft.programId, draft.sessionDate);
  if (!rate) w.push({ code: "missing_rate", severity: "warning", message: "No rate is configured for this program on this date; expected billing cannot be computed." });

  // Employee active + not double-booked.
  if (draft.employeeId) {
    const emp = await pool.query<{ status: string; display_name: string }>(
      `SELECT status, display_name FROM employees WHERE id = $1`,
      [draft.employeeId],
    );
    if (emp.rows[0] && emp.rows[0].status !== "active") {
      w.push({ code: "employee_inactive", severity: "warning", message: `Employee ${emp.rows[0].display_name} is ${emp.rows[0].status}.` });
    }
    const clashes = await pool.query<{ id: string; start_time: string | null; end_time: string | null }>(
      `SELECT id, start_time, end_time FROM scheduled_sessions
       WHERE employee_id = $1 AND session_date = $2 AND status IN ('pending','completed')
         AND ($3::uuid IS NULL OR id <> $3)`,
      [draft.employeeId, draft.sessionDate, excludeSessionId ?? null],
    );
    if (clashes.rows.some((c) => timesOverlap(draft.startTime, draft.endTime, c.start_time, c.end_time))) {
      w.push({ code: "employee_double_booked", severity: "warning", message: "This employee already has an overlapping session that day." });
    }
  }

  for (const individualId of draft.individualIds) {
    const ind = await pool.query<{ status: string; display_name: string }>(
      `SELECT status, display_name FROM individuals WHERE id = $1`,
      [individualId],
    );
    const name = ind.rows[0]?.display_name ?? "individual";
    if (ind.rows[0] && ind.rows[0].status !== "active") {
      w.push({ code: "individual_inactive", severity: "warning", message: `${name} is ${ind.rows[0].status}.` });
    }
    // Individual double-booked.
    const clashes = await pool.query<{ start_time: string | null; end_time: string | null }>(
      `SELECT s.start_time, s.end_time FROM scheduled_allocations a
       JOIN scheduled_sessions s ON s.id = a.scheduled_session_id
       WHERE a.individual_id = $1 AND s.session_date = $2 AND s.status IN ('pending','completed')
         AND ($3::uuid IS NULL OR s.id <> $3)`,
      [individualId, draft.sessionDate, excludeSessionId ?? null],
    );
    if (clashes.rows.some((c) => timesOverlap(draft.startTime, draft.endTime, c.start_time, c.end_time))) {
      w.push({ code: "individual_double_booked", severity: "warning", message: `${name} already has an overlapping session that day.` });
    }
    // Assignment: is this employee allowed to serve this individual for this program?
    if (draft.employeeId) {
      const assigned = await pool.query(
        `SELECT 1 FROM assignments WHERE employee_id = $1 AND individual_id = $2
           AND status = 'active' AND (program_id IS NULL OR program_id = $3) LIMIT 1`,
        [draft.employeeId, individualId, draft.programId],
      );
      if (!assigned.rows[0]) {
        w.push({ code: "not_assigned", severity: "warning", message: `The employee is not assigned to ${name} for this program.` });
      }
    }
    // Authorization: within dates and within remaining hours.
    const auth = await pool.query<{ authorized_hours: string; start_date: string; end_date: string }>(
      `SELECT ba.authorized_hours::text, bp.start_date::text, bp.end_date::text
       FROM budget_authorizations ba JOIN budget_periods bp ON bp.id = ba.budget_period_id
       WHERE ba.individual_id = $1 AND ba.program_id = $2 AND ba.status = 'active'
         AND bp.status = 'active'
       ORDER BY bp.start_date DESC LIMIT 1`,
      [individualId, draft.programId],
    );
    if (!auth.rows[0]) {
      w.push({ code: "missing_authorization", severity: "warning", message: `${name} has no active authorization for this program.` });
    } else {
      const a = auth.rows[0];
      if (draft.sessionDate < a.start_date || draft.sessionDate > a.end_date) {
        w.push({ code: "outside_authorization_dates", severity: "warning", message: `${draft.sessionDate} is outside ${name}'s authorization period (${a.start_date} to ${a.end_date}).` });
      }
      const used = await pool.query<{ h: string }>(
        `SELECT COALESCE(sum(al.allocation_hours),0)::text AS h
         FROM service_allocations al JOIN service_sessions ss ON ss.id = al.service_session_id
         WHERE al.individual_id = $1 AND ss.program_id = $2`,
        [individualId, draft.programId],
      );
      const scheduled = await pool.query<{ h: string }>(
        `SELECT COALESCE(sum(sa.allocation_hours),0)::text AS h
         FROM scheduled_allocations sa JOIN scheduled_sessions s ON s.id = sa.scheduled_session_id
         WHERE sa.individual_id = $1 AND s.program_id = $2 AND s.status = 'pending'
           AND ($3::uuid IS NULL OR s.id <> $3)`,
        [individualId, draft.programId, excludeSessionId ?? null],
      );
      const projected = dec(used.rows[0].h).plus(dec(scheduled.rows[0].h)).plus(hours);
      if (projected.gt(dec(a.authorized_hours))) {
        w.push({
          code: "over_authorized_hours",
          severity: "warning",
          message: `Scheduling this would bring ${name} to ${toHours(projected)} h against ${toHours(a.authorized_hours)} authorized.`,
        });
      }
    }
  }

  // Program-rule checks driven by configuration, not hard-coded assumptions.
  if (rules) {
    if (isGroup && !rules.groups_allowed) {
      w.push({ code: "program_not_group", severity: "warning", message: `${rules.name} is one-to-one; group scheduling is not enabled for it.` });
    }
    if (isGroup && rules.max_group_size != null && draft.individualIds.length > rules.max_group_size) {
      w.push({ code: "group_over_max", severity: "warning", message: `Group of ${draft.individualIds.length} exceeds the maximum of ${rules.max_group_size} for ${rules.name}.` });
    }
    // One individual scheduled with two DIFFERENT employees at once, in a
    // program that requires one-to-one and does not allow multiple employees.
    if (rules.one_to_one_required && !rules.allow_multiple_employees && draft.employeeId) {
      for (const individualId of draft.individualIds) {
        const others = await pool.query<{ employee_id: string | null; start_time: string | null; end_time: string | null }>(
          `SELECT s.employee_id, s.start_time, s.end_time
           FROM scheduled_allocations a JOIN scheduled_sessions s ON s.id = a.scheduled_session_id
           WHERE a.individual_id = $1 AND s.session_date = $2 AND s.status IN ('pending','completed')
             AND s.employee_id IS NOT NULL AND s.employee_id <> $3
             AND ($4::uuid IS NULL OR s.id <> $4)`,
          [individualId, draft.sessionDate, draft.employeeId, excludeSessionId ?? null],
        );
        if (others.rows.some((o) => timesOverlap(draft.startTime, draft.endTime, o.start_time, o.end_time))) {
          w.push({ code: "individual_two_employees_one_to_one", severity: "warning", message: `${rules.name} is one-to-one, but this individual already has an overlapping session with another employee.` });
          break;
        }
      }
    }
  }
  return w;
}

export interface SessionForecastRow {
  individualId: string;
  individualName: string;
  authorizedHours: string | null;
  actualHours: string;
  actualAmount: string;
  scheduledHours: string;
  scheduledAmount: string;
  thisHours: string;
  thisAmount: string | null;
  remainingAfterHours: string | null;
}

export interface SessionPreview {
  durationHours: string;
  warnings: ScheduleWarning[];
  billing: ReturnType<typeof expectedBilling> | null;
  forecast: SessionForecastRow[];
}

/**
 * Compute — without persisting anything — the warnings, expected billing and
 * per-individual forecast for a draft session. Powers the live figures in the
 * scheduling form so a manager sees the consequences before saving.
 */
export async function previewSession(
  pool: PgLikePool,
  draft: SessionDraft,
  excludeSessionId?: string | null,
): Promise<SessionPreview> {
  const duration =
    draft.durationHours && dec(draft.durationHours).gt(0)
      ? toHours(draft.durationHours)
      : durationBetween(draft.startTime, draft.endTime);
  const effective: SessionDraft = { ...draft, durationHours: duration ?? "0" };

  const warnings = duration ? await detectConflicts(pool, effective, excludeSessionId ?? undefined) : [];
  const rate = await currentRate(pool, draft.programId, draft.sessionDate);
  const groupSize = draft.individualIds.length;
  const billing =
    duration && rate
      ? expectedBilling({ hours: duration, groupSize, agencyRate: rate.agencyRate, internalRate: rate.internalRate })
      : null;

  const forecast: SessionForecastRow[] = [];
  for (const individualId of draft.individualIds) {
    if (!isUuid(individualId)) continue;
    const nameRow = await pool.query<{ display_name: string }>(
      `SELECT display_name FROM individuals WHERE id = $1`,
      [individualId],
    );
    const f = await individualProgramForecast(pool, individualId, draft.programId, excludeSessionId ?? null);
    const thisHours = duration ?? "0";
    const remainingAfterHours =
      f.remainingAfterScheduleHours === null
        ? null
        : toHours(dec(f.remainingAfterScheduleHours).minus(dec(thisHours)));
    forecast.push({
      individualId,
      individualName: nameRow.rows[0]?.display_name ?? "Individual",
      authorizedHours: f.authorizedHours,
      actualHours: f.actualHours,
      actualAmount: f.actualAmount,
      scheduledHours: f.scheduledHours,
      scheduledAmount: f.scheduledAmount,
      thisHours: toHours(thisHours),
      thisAmount: billing ? billing.perIndividual.amount : null,
      remainingAfterHours,
    });
  }

  return { durationHours: duration ?? "0", warnings, billing, forecast };
}

export interface CreateSessionInput extends SessionDraft {
  serviceType?: string | null;
  notes?: string | null;
  overrideReason?: string | null;
  seriesId?: string | null;
  source?: string;
}

async function insertSessionWithAllocations(
  pool: PgLikePool,
  input: CreateSessionInput,
  actorId: string | null,
): Promise<{ id: string; warnings: ScheduleWarning[] }> {
  const duration =
    input.durationHours && dec(input.durationHours).gt(0)
      ? toHours(input.durationHours)
      : durationBetween(input.startTime, input.endTime);
  if (!duration) throw new Error("A positive duration (or a valid start/end time) is required.");

  const draft: SessionDraft = { ...input, durationHours: duration };
  const warnings = await detectConflicts(pool, draft);
  const rate = await currentRate(pool, input.programId, input.sessionDate);
  const groupSize = input.individualIds.length;
  const billing = rate
    ? expectedBilling({ hours: duration, groupSize, agencyRate: rate.agencyRate, internalRate: rate.internalRate })
    : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO scheduled_sessions
        (series_id, employee_id, program_id, service_type, session_date, start_time, end_time,
         duration_hours, is_group, group_size, expected_rate, expected_agency_gross,
         expected_internal_amount, expected_agency_additional, status, override_reason, warnings, source, notes, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        input.seriesId ?? null,
        input.employeeId,
        input.programId,
        input.serviceType ?? null,
        input.sessionDate,
        input.startTime,
        input.endTime,
        duration,
        groupSize > 1,
        groupSize,
        billing ? billing.expectedRate : null,
        billing ? billing.agencyGross : null,
        billing ? billing.internalAmount : null,
        billing ? billing.agencyAdditional : null,
        input.overrideReason ?? null,
        warnings.length ? JSON.stringify(warnings) : null,
        input.source ?? "manual",
        input.notes ?? null,
        actorId,
      ],
    );
    const sessionId = rows[0]!.id;
    for (const individualId of input.individualIds) {
      await client.query(
        `INSERT INTO scheduled_allocations
           (scheduled_session_id, individual_id, allocation_hours, allocated_rate, allocated_amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          sessionId,
          individualId,
          duration, // FULL hours per individual — never divided
          billing ? billing.perIndividual.rate : null,
          billing ? billing.perIndividual.amount : null,
        ],
      );
    }
    await client.query("COMMIT");
    return { id: sessionId, warnings };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createSession(
  pool: PgLikePool,
  input: CreateSessionInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string; warnings: ScheduleWarning[] }>> {
  if (!isUuid(input.programId)) return fail("validation", "Choose a program.");
  const individualIds = (input.individualIds ?? []).filter(isUuid);
  if (individualIds.length === 0) return fail("validation", "Choose at least one individual.");
  if (input.employeeId && !isUuid(input.employeeId)) return fail("validation", "Invalid employee.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sessionDate)) return fail("validation", "Give a session date.");
  try {
    const result = await insertSessionWithAllocations(pool, { ...input, individualIds }, actorId);
    await recordChange(pool, {
      actorId,
      action: "session_scheduled",
      entityType: "scheduled_session",
      entityId: result.id,
      next: { date: input.sessionDate, program: input.programId, individuals: individualIds.length, warnings: result.warnings.length },
      reason: reason ?? input.overrideReason ?? null,
    });
    return ok(result);
  } catch (error) {
    return fail("validation", error instanceof Error ? error.message : "Could not schedule the session.");
  }
}

export interface CreateSeriesInput extends Omit<CreateSessionInput, "sessionDate"> {
  frequency: "weekly" | "daily";
  interval?: number;
  weekdays?: number[];
  startDate: string;
  endDate: string;
}

export async function createSeries(
  pool: PgLikePool,
  input: CreateSeriesInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ seriesId: string; created: number; warnings: number }>> {
  if (!isUuid(input.programId)) return fail("validation", "Choose a program.");
  const individualIds = (input.individualIds ?? []).filter(isUuid);
  if (individualIds.length === 0) return fail("validation", "Choose at least one individual.");
  const dates = generateOccurrences({
    frequency: input.frequency,
    interval: input.interval,
    weekdays: input.weekdays,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  if (dates.length === 0) return fail("validation", "That recurrence produces no dates. Check the range and weekdays.");

  const duration =
    input.durationHours && dec(input.durationHours).gt(0)
      ? toHours(input.durationHours)
      : durationBetween(input.startTime, input.endTime);
  if (!duration) return fail("validation", "Give a duration or start/end time.");

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO schedule_series
       (employee_id, program_id, service_type, frequency, interval, weekdays,
        start_date, end_date, start_time, end_time, duration_hours, status, notes, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13) RETURNING id`,
    [
      input.employeeId, input.programId, input.serviceType ?? null, input.frequency,
      Math.max(1, Math.floor(input.interval ?? 1)), JSON.stringify(input.weekdays ?? []),
      input.startDate, input.endDate, input.startTime, input.endTime, duration,
      input.notes ?? null, actorId,
    ],
  );
  const seriesId = rows[0]!.id;
  let warnings = 0;
  for (const sessionDate of dates) {
    const r = await insertSessionWithAllocations(
      pool,
      { ...input, individualIds, sessionDate, seriesId, source: "recurring", durationHours: duration },
      actorId,
    );
    warnings += r.warnings.length;
  }
  await recordChange(pool, {
    actorId,
    action: "series_scheduled",
    entityType: "schedule_series",
    entityId: seriesId,
    next: { occurrences: dates.length, frequency: input.frequency },
    reason,
  });
  return ok({ seriesId, created: dates.length, warnings });
}

export async function setSessionStatus(
  pool: PgLikePool,
  id: string,
  status: "pending" | "completed" | "cancelled" | "no_show",
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(id)) return fail("not_found", "That session no longer exists.");
  const before = await pool.query<{ status: string }>(`SELECT status FROM scheduled_sessions WHERE id = $1`, [id]);
  if (!before.rows[0]) return fail("not_found", "That session no longer exists.");
  await pool.query(`UPDATE scheduled_sessions SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  await recordChange(pool, {
    actorId, action: `session_${status}`, entityType: "scheduled_session", entityId: id,
    previous: { status: before.rows[0].status }, next: { status }, reason,
  });
  return ok({ id });
}

export async function rescheduleSession(
  pool: PgLikePool,
  id: string,
  to: { sessionDate?: string; startTime?: string | null; endTime?: string | null },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string; warnings: ScheduleWarning[] }>> {
  if (!isUuid(id)) return fail("not_found", "That session no longer exists.");
  const { rows } = await pool.query<{
    employee_id: string | null; program_id: string; session_date: string;
    start_time: string | null; end_time: string | null; duration_hours: string;
  }>(
    `SELECT employee_id, program_id, session_date::text, start_time, end_time, duration_hours::text
     FROM scheduled_sessions WHERE id = $1`,
    [id],
  );
  const s = rows[0];
  if (!s) return fail("not_found", "That session no longer exists.");
  const sessionDate = to.sessionDate ?? s.session_date;
  const startTime = to.startTime === undefined ? s.start_time : to.startTime;
  const endTime = to.endTime === undefined ? s.end_time : to.endTime;
  const inds = await pool.query<{ individual_id: string }>(
    `SELECT individual_id FROM scheduled_allocations WHERE scheduled_session_id = $1`,
    [id],
  );
  const warnings = await detectConflicts(
    pool,
    { employeeId: s.employee_id, programId: s.program_id, individualIds: inds.rows.map((r) => r.individual_id), sessionDate, startTime, endTime, durationHours: s.duration_hours },
    id,
  );
  await pool.query(
    `UPDATE scheduled_sessions SET session_date = $2, start_time = $3, end_time = $4,
       warnings = $5, updated_at = now() WHERE id = $1`,
    [id, sessionDate, startTime, endTime, warnings.length ? JSON.stringify(warnings) : null],
  );
  await recordChange(pool, {
    actorId, action: "session_rescheduled", entityType: "scheduled_session", entityId: id,
    previous: { date: s.session_date, start: s.start_time }, next: { date: sessionDate, start: startTime }, reason,
  });
  return ok({ id, warnings });
}

export async function duplicateSession(
  pool: PgLikePool,
  id: string,
  toDate: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string; warnings: ScheduleWarning[] }>> {
  if (!isUuid(id)) return fail("not_found", "That session no longer exists.");
  const { rows } = await pool.query<{
    employee_id: string | null; program_id: string; service_type: string | null;
    start_time: string | null; end_time: string | null; duration_hours: string; notes: string | null;
  }>(
    `SELECT employee_id, program_id, service_type, start_time, end_time, duration_hours::text, notes
     FROM scheduled_sessions WHERE id = $1`,
    [id],
  );
  const s = rows[0];
  if (!s) return fail("not_found", "That session no longer exists.");
  const inds = await pool.query<{ individual_id: string }>(
    `SELECT individual_id FROM scheduled_allocations WHERE scheduled_session_id = $1`,
    [id],
  );
  return createSession(
    pool,
    {
      employeeId: s.employee_id, programId: s.program_id, individualIds: inds.rows.map((r) => r.individual_id),
      sessionDate: toDate, startTime: s.start_time, endTime: s.end_time, durationHours: s.duration_hours,
      serviceType: s.service_type, notes: s.notes,
    },
    actorId,
    reason ?? "duplicated",
  );
}

export async function cancelSeries(
  pool: PgLikePool,
  seriesId: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ cancelled: number }>> {
  if (!isUuid(seriesId)) return fail("not_found", "That series no longer exists.");
  const { rowCount } = await pool.query(
    `UPDATE scheduled_sessions SET status = 'cancelled', updated_at = now()
     WHERE series_id = $1 AND status = 'pending'`,
    [seriesId],
  );
  await pool.query(`UPDATE schedule_series SET status = 'cancelled', updated_at = now() WHERE id = $1`, [seriesId]);
  await recordChange(pool, {
    actorId, action: "series_cancelled", entityType: "schedule_series", entityId: seriesId,
    next: { cancelledOccurrences: rowCount ?? 0 }, reason,
  });
  return ok({ cancelled: rowCount ?? 0 });
}
