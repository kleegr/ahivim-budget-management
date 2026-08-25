import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { dec, toHours } from "@/lib/money";
import {
  expectedBilling, durationBetween, timesOverlap, generateOccurrences, MAX_SERIES_OCCURRENCES,
} from "@/lib/business/scheduling";
import { resolveEffectiveRate } from "@/lib/business/rate-resolver";
import { individualProgramForecast } from "@/lib/data/schedule-queries";

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
type ScheduleQueryable = Pick<PgLikePool, "query">;
const LIVE_SUCCESSOR_CONSTRAINT = "schedule_series_one_live_successor_key";
const EXISTING_SUCCESSOR_MESSAGE = "This schedule already has an upcoming version. Refresh and edit the upcoming version instead.";
const SERIES_OCCURRENCE_LIMIT_MESSAGE = `A recurring schedule can include up to ${MAX_SERIES_OCCURRENCES} visits. Shorten the date range or use a longer interval.`;
export const SCHEDULE_OVERRIDE_REQUIRED_MESSAGE = "Review the schedule warnings and add a written override reason before saving.";

class ScheduleOverrideRequiredError extends Error {}

function writtenOverrideReason(reason?: string | null, fallback?: string | null): string | null {
  return reason?.trim() || fallback?.trim() || null;
}

function plannerWarnings(warnings: ScheduleWarning[]): ScheduleWarning[] {
  return warnings.filter((warning) => warning.code !== "missing_rate");
}

function postgresErrorField(error: unknown, field: "code" | "constraint"): string {
  return typeof error === "object" && error !== null && field in error
    ? String((error as Record<string, unknown>)[field] ?? "")
    : "";
}

function isLiveSuccessorConflict(error: unknown): boolean {
  return postgresErrorField(error, "code") === "23505"
    && postgresErrorField(error, "constraint") === LIVE_SUCCESSOR_CONSTRAINT;
}

function scheduleSaveMessage(error: unknown, fallback: string): string {
  const code = postgresErrorField(error, "code");
  if (code === "23503") {
    return "A selected employee, individual, or program is no longer available. Refresh and try again.";
  }
  if (code.startsWith("23") || code === "22007" || code === "22008") {
    return "The schedule conflicts with current data. Refresh your selections and try again.";
  }
  return fallback;
}

export interface ScheduleWarning {
  code: string;
  severity: "warning" | "error";
  message: string;
}

/** The rate in force for a program on a date, via the one effective-dated resolver. */
export async function currentRate(
  pool: ScheduleQueryable,
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
  pool: ScheduleQueryable,
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
           AND status = 'active' AND archived_at IS NULL
           AND (program_id IS NULL OR program_id = $3)
           AND (start_date IS NULL OR start_date <= $4::date)
           AND (end_date IS NULL OR end_date >= $4::date)
         LIMIT 1`,
        [draft.employeeId, individualId, draft.programId, draft.sessionDate],
      );
      if (!assigned.rows[0]) {
        w.push({ code: "not_assigned", severity: "warning", message: `The employee is not assigned to ${name} for this program.` });
      }
    }
    // Authorization: within dates and within remaining hours.
    const auth = await pool.query<{ start_date: string; end_date: string }>(
      `SELECT ea.start_date::text, ea.end_date::text
         FROM effective_budget_authorizations_at($3::date) ea
        WHERE ea.individual_id = $1 AND ea.program_id = $2
        ORDER BY ea.start_date, ea.end_date, ea.authorization_id`,
      [individualId, draft.programId, draft.sessionDate],
    );
    if (auth.rows.length === 0) {
      const explicitPeriods = await pool.query<{ start_date: string; end_date: string }>(
        `SELECT bp.start_date::text, bp.end_date::text
           FROM budget_authorizations ba
           JOIN budget_periods bp ON bp.id = ba.budget_period_id
          WHERE ba.individual_id = $1 AND ba.program_id = $2
            AND ba.status = 'active' AND ba.archived_at IS NULL
            AND bp.status = 'active'
          ORDER BY bp.start_date, bp.end_date, ba.id`,
        [individualId, draft.programId],
      );
      if (explicitPeriods.rows.length > 0) {
        const ranges = explicitPeriods.rows
          .map((period) => `${period.start_date} to ${period.end_date}`)
          .join(", ");
        w.push({
          code: "outside_authorization_dates",
          severity: "warning",
          message: `${draft.sessionDate} is outside ${name}'s authorization period${explicitPeriods.rows.length === 1 ? "" : "s"} (${ranges}).`,
        });
      } else {
        w.push({ code: "missing_authorization", severity: "warning", message: `${name} has no active authorization for this program.` });
      }
    } else {
      const forecast = await individualProgramForecast(
        pool,
        individualId,
        draft.programId,
        excludeSessionId ?? null,
        draft.sessionDate,
      );
      if (forecast.authorizationAmbiguous) {
        w.push({
          code: "ambiguous_authorization",
          severity: "warning",
          message: `${name} has ${forecast.authorizationCount} overlapping authorizations for this program. Review the authorization periods before scheduling.`,
        });
      } else {
        const projected = dec(forecast.actualHours).plus(forecast.scheduledHours).plus(hours);
        if (forecast.authorizedHours !== null && projected.gt(forecast.authorizedHours)) {
          w.push({
            code: "over_authorized_hours",
            severity: "warning",
            message: `Scheduling this would bring ${name} to ${toHours(projected)} h against ${toHours(forecast.authorizedHours)} authorized.`,
          });
        }
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
  scheduledHours: string;
  thisHours: string;
  remainingAfterHours: string | null;
  authorizationCount: number;
  authorizationAmbiguous: boolean;
}

export interface SessionPreview {
  durationHours: string;
  warnings: ScheduleWarning[];
  forecast: SessionForecastRow[];
}

/**
 * Compute — without persisting anything — the operational warnings and
 * per-individual hour forecast for a draft session. Money remains outside the
 * planning surface even though createSession still stores expected amounts for
 * reconciliation behind the scenes.
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

  const warnings = duration
    ? (await detectConflicts(pool, effective, excludeSessionId ?? undefined))
        .filter((warning) => warning.code !== "missing_rate")
    : [];

  const forecast: SessionForecastRow[] = [];
  for (const individualId of draft.individualIds) {
    if (!isUuid(individualId)) continue;
    const nameRow = await pool.query<{ display_name: string }>(
      `SELECT display_name FROM individuals WHERE id = $1`,
      [individualId],
    );
    const f = await individualProgramForecast(
      pool,
      individualId,
      draft.programId,
      excludeSessionId ?? null,
      draft.sessionDate,
    );
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
      scheduledHours: f.scheduledHours,
      thisHours: toHours(thisHours),
      remainingAfterHours,
      authorizationCount: f.authorizationCount,
      authorizationAmbiguous: f.authorizationAmbiguous,
    });
  }

  return { durationHours: duration ?? "0", warnings, forecast };
}

export interface CreateSessionInput extends SessionDraft {
  serviceType?: string | null;
  notes?: string | null;
  overrideReason?: string | null;
  seriesId?: string | null;
  source?: string;
}

async function insertSessionRows(
  db: ScheduleQueryable,
  input: CreateSessionInput,
  actorId: string | null,
): Promise<{ id: string; warnings: ScheduleWarning[] }> {
  const duration =
    input.durationHours && dec(input.durationHours).gt(0)
      ? toHours(input.durationHours)
      : durationBetween(input.startTime, input.endTime);
  if (!duration) throw new Error("A positive duration (or a valid start/end time) is required.");

  const individualIds = [...new Set(input.individualIds)];
  if (individualIds.length === 0) throw new Error("Choose at least one individual.");
  const draft: SessionDraft = { ...input, individualIds, durationHours: duration };
  const warnings = await detectConflicts(db, draft);
  const rate = await currentRate(db, input.programId, input.sessionDate);
  const groupSize = individualIds.length;
  const billing = rate
    ? expectedBilling({ hours: duration, groupSize, agencyRate: rate.agencyRate, internalRate: rate.internalRate })
    : null;

  const { rows } = await db.query<{ id: string }>(
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
  for (const individualId of individualIds) {
    await db.query(
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
  return { id: sessionId, warnings };
}

async function insertSessionWithAllocations(
  pool: PgLikePool,
  input: CreateSessionInput,
  actorId: string | null,
): Promise<{ id: string; warnings: ScheduleWarning[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await insertSessionRows(client, input, actorId);
    if (plannerWarnings(result.warnings).length > 0 && !writtenOverrideReason(input.overrideReason)) {
      throw new ScheduleOverrideRequiredError(SCHEDULE_OVERRIDE_REQUIRED_MESSAGE);
    }
    await client.query("COMMIT");
    return result;
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
  const individualIds = [...new Set((input.individualIds ?? []).filter(isUuid))];
  if (individualIds.length === 0) return fail("validation", "Choose at least one individual.");
  if (input.employeeId && !isUuid(input.employeeId)) return fail("validation", "Invalid employee.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sessionDate)) return fail("validation", "Give a session date.");
  const overrideReason = writtenOverrideReason(reason, input.overrideReason);
  try {
    const result = await insertSessionWithAllocations(
      pool,
      { ...input, individualIds, overrideReason },
      actorId,
    );
    await recordChange(pool, {
      actorId,
      action: "session_scheduled",
      entityType: "scheduled_session",
      entityId: result.id,
      next: { date: input.sessionDate, program: input.programId, individuals: individualIds.length, warnings: result.warnings.length },
      reason: overrideReason,
    });
    return ok(result);
  } catch (error) {
    if (error instanceof ScheduleOverrideRequiredError) {
      return fail("validation", SCHEDULE_OVERRIDE_REQUIRED_MESSAGE);
    }
    return fail("validation", scheduleSaveMessage(error, "Could not save the session. Try again."));
  }
}

export interface CreateSeriesInput extends Omit<CreateSessionInput, "sessionDate"> {
  frequency: "weekly" | "daily";
  interval?: number;
  weekdays?: number[];
  startDate: string;
  endDate: string;
}

function normalizedIndividuals(input: CreateSeriesInput): string[] {
  return [...new Set((input.individualIds ?? []).filter(isUuid))];
}

function normalizedWeekdays(input: CreateSeriesInput): number[] {
  return [...new Set((input.weekdays ?? []).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    .sort((a, b) => a - b);
}

function seriesDuration(input: CreateSeriesInput): string | null {
  return input.durationHours && dec(input.durationHours).gt(0)
    ? toHours(input.durationHours)
    : durationBetween(input.startTime, input.endTime);
}

export function validateSeriesInput(
  input: CreateSeriesInput,
  options: { enforceOccurrenceLimit?: boolean } = {},
): string | null {
  if (!isUuid(input.programId)) return "Choose a program.";
  if (normalizedIndividuals(input).length === 0) return "Choose at least one individual.";
  if (input.employeeId && !isUuid(input.employeeId)) return "Invalid employee.";
  if (input.frequency !== "weekly" && input.frequency !== "daily") return "Choose a recurrence frequency.";
  if (input.frequency === "weekly" && normalizedWeekdays(input).length === 0) {
    return "Choose at least one weekday.";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
    return "Give valid effective dates.";
  }
  if (!seriesDuration(input)) return "Give a duration or start/end time.";
  const dates = generateOccurrences({
    frequency: input.frequency,
    interval: input.interval,
    weekdays: normalizedWeekdays(input),
    startDate: input.startDate,
    endDate: input.endDate,
    max: options.enforceOccurrenceLimit === false ? 1 : MAX_SERIES_OCCURRENCES + 1,
  });
  if (dates.length === 0) return "That recurrence produces no dates. Check the range and weekdays.";
  if (dates.length > MAX_SERIES_OCCURRENCES) return SERIES_OCCURRENCE_LIMIT_MESSAGE;
  return null;
}

export async function createSeries(
  pool: PgLikePool,
  input: CreateSeriesInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ seriesId: string; created: number; warnings: number }>> {
  const validation = validateSeriesInput(input);
  if (validation) return fail("validation", validation);
  const individualIds = normalizedIndividuals(input);
  const weekdays = normalizedWeekdays(input);
  const dates = generateOccurrences({
    frequency: input.frequency,
    interval: input.interval,
    weekdays,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  const duration = seriesDuration(input)!;
  const overrideReason = writtenOverrideReason(reason, input.overrideReason);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO schedule_series
         (employee_id, program_id, service_type, frequency, interval, weekdays,
          recurrence_anchor_date, start_date, end_date, start_time, end_time,
          duration_hours, status, notes, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,'active',$12,$13) RETURNING id`,
      [
        input.employeeId, input.programId, input.serviceType ?? null, input.frequency,
        Math.max(1, Math.floor(input.interval ?? 1)), JSON.stringify(weekdays),
        input.startDate, input.endDate, input.startTime, input.endTime, duration,
        input.notes ?? null, actorId,
      ],
    );
    const seriesId = rows[0]!.id;
    for (const individualId of individualIds) {
      await client.query(
        `INSERT INTO schedule_series_individuals (series_id, individual_id) VALUES ($1, $2)`,
        [seriesId, individualId],
      );
    }
    let warnings = 0;
    for (const sessionDate of dates) {
      const result = await insertSessionRows(
        client,
        {
          ...input,
          individualIds,
          sessionDate,
          seriesId,
          source: "recurring",
          durationHours: duration,
          overrideReason,
        },
        actorId,
      );
      warnings += plannerWarnings(result.warnings).length;
    }
    if (warnings > 0 && !overrideReason) {
      await client.query("ROLLBACK");
      return fail("validation", SCHEDULE_OVERRIDE_REQUIRED_MESSAGE);
    }
    await recordChange(client, {
      actorId,
      action: "series_scheduled",
      entityType: "schedule_series",
      entityId: seriesId,
      next: { occurrences: dates.length, frequency: input.frequency, individualIds },
      reason: overrideReason,
    });
    await client.query("COMMIT");
    return ok({ seriesId, created: dates.length, warnings });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return fail("validation", scheduleSaveMessage(error, "Could not create the recurring schedule. Try again."));
  } finally {
    client.release();
  }
}

export interface UpdateSeriesInput extends Omit<CreateSeriesInput, "seriesId" | "source"> {
  status: "active" | "cancelled";
  /** First pending occurrence that should use the edited schedule. Defaults to today. */
  applyFromDate?: string;
}

export interface UpdateSeriesResult {
  seriesId: string;
  previousSeriesId: string | null;
  split: boolean;
  applyFromDate: string;
  replaced: number;
  created: number;
  preserved: number;
  warnings: number;
}

/**
 * Replace the still-pending part of a recurring service schedule atomically.
 * Completed, cancelled, no-show, matched, and past occurrences remain exactly
 * as recorded; only unconsumed occurrences from the requested application date
 * forward are regenerated.
 */
export async function updateSeries(
  pool: PgLikePool,
  seriesId: string,
  input: UpdateSeriesInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<UpdateSeriesResult>> {
  if (!isUuid(seriesId)) return fail("not_found", "That series no longer exists.");
  const validation = validateSeriesInput(input, { enforceOccurrenceLimit: false });
  if (validation) return fail("validation", validation);
  if (input.status !== "active" && input.status !== "cancelled") {
    return fail("validation", "Choose an active or cancelled status.");
  }
  if (input.applyFromDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.applyFromDate)) {
    return fail("validation", "Give a valid date for applying the changes.");
  }
  const individualIds = normalizedIndividuals(input);
  const weekdays = normalizedWeekdays(input);
  const duration = seriesDuration(input)!;
  const interval = Math.max(1, Math.floor(input.interval ?? 1));
  const overrideReason = writtenOverrideReason(reason, input.overrideReason);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const { rows: currentRows } = await client.query<{
      employee_id: string | null;
      program_id: string;
      service_type: string | null;
      frequency: string;
      interval: number;
      weekdays: unknown;
      recurrence_anchor_date: string;
      start_date: string;
      end_date: string;
      start_time: string | null;
      end_time: string | null;
      duration_hours: string;
      status: string;
      notes: string | null;
      today: string;
    }>(
      `SELECT employee_id, program_id, service_type, frequency, interval, weekdays,
              recurrence_anchor_date::text,
              start_date::text, end_date::text, start_time, end_time,
              duration_hours::text, status, notes, CURRENT_DATE::text AS today
         FROM schedule_series
        WHERE id = $1 AND archived_at IS NULL
        FOR UPDATE`,
      [seriesId],
    );
    const current = currentRows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return fail("not_found", "That series no longer exists.");
    }

    if (input.applyFromDate && input.applyFromDate < current.today) {
      await client.query("ROLLBACK");
      return fail("validation", "Schedule changes cannot be applied before today.");
    }
    const applyFromDate = input.applyFromDate ?? current.today;
    if (applyFromDate > input.endDate) {
      await client.query("ROLLBACK");
      return fail("validation", "The change date must be on or before the schedule end date.");
    }
    const split = applyFromDate > current.today;
    if (split && input.status !== "active") {
      await client.query("ROLLBACK");
      return fail("validation", "Use End schedule to cancel a future schedule.");
    }
    if (split) {
      const { rows: successorRows } = await client.query<{ id: string }>(
        `SELECT id
           FROM schedule_series
          WHERE supersedes_series_id = $1
            AND archived_at IS NULL`,
        [seriesId],
      );
      if (successorRows[0]) {
        await client.query("ROLLBACK");
        return fail("conflict", EXISTING_SUCCESSOR_MESSAGE);
      }
    }
    const recurrenceAnchorDate = input.startDate === current.start_date
      ? current.recurrence_anchor_date
      : input.startDate;
    const effectiveStartDate = input.startDate > applyFromDate ? input.startDate : applyFromDate;
    const candidateDates = input.status === "active"
      ? generateOccurrences({
          frequency: input.frequency,
          interval,
          weekdays,
          startDate: recurrenceAnchorDate,
          endDate: input.endDate,
          fromDate: effectiveStartDate,
          max: MAX_SERIES_OCCURRENCES + 1,
        })
      : [];
    if (candidateDates.length > MAX_SERIES_OCCURRENCES) {
      await client.query("ROLLBACK");
      return fail("validation", SERIES_OCCURRENCE_LIMIT_MESSAGE);
    }
    const { rows: previousParticipantRows } = await client.query<{ individual_id: string }>(
      `SELECT individual_id::text
         FROM schedule_series_individuals
        WHERE series_id = $1
        ORDER BY individual_id`,
      [seriesId],
    );
    const previousIndividualIds = previousParticipantRows.map((row) => row.individual_id);
    const { rows: preservedRows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM scheduled_sessions
        WHERE series_id = $1
          AND NOT (
            status = 'pending'
            AND matched_transaction_id IS NULL
            AND session_date >= $2::date
          )`,
      [seriesId, applyFromDate],
    );
    const { rows: protectedFutureRows } = await client.query<{ session_date: string }>(
      `SELECT DISTINCT session_date::text
         FROM scheduled_sessions
        WHERE series_id = $1
          AND session_date >= $2::date
          AND (status <> 'pending' OR matched_transaction_id IS NOT NULL)`,
      [seriesId, applyFromDate],
    );
    const protectedFutureDates = new Set(protectedFutureRows.map((row) => row.session_date));

    let targetSeriesId = seriesId;
    let replaced = 0;
    let oldEndDate = current.end_date;
    let oldStatus = current.status;
    if (split) {
      const cancelled = await client.query(
        `UPDATE scheduled_sessions
            SET status = 'cancelled', updated_at = now()
          WHERE series_id = $1
            AND status = 'pending'
            AND matched_transaction_id IS NULL
            AND session_date >= $2::date`,
        [seriesId, applyFromDate],
      );
      replaced = cancelled.rowCount ?? 0;
      const dayBefore = new Date(`${applyFromDate}T00:00:00Z`);
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      const preChangeEnd = dayBefore.toISOString().slice(0, 10);
      if (current.start_date < applyFromDate) {
        oldEndDate = current.end_date < preChangeEnd ? current.end_date : preChangeEnd;
      } else {
        oldStatus = "cancelled";
      }
      await client.query(
        `UPDATE schedule_series
            SET end_date = $2, status = $3, updated_at = now()
          WHERE id = $1`,
        [seriesId, oldEndDate, oldStatus],
      );
      const createdSeries = await client.query<{ id: string }>(
        `INSERT INTO schedule_series
           (employee_id, program_id, service_type, frequency, interval, weekdays,
            recurrence_anchor_date, supersedes_series_id, start_date, end_date,
            start_time, end_time, duration_hours, status, notes, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',$14,$15)
         RETURNING id`,
        [
          input.employeeId, input.programId, input.serviceType ?? null,
          input.frequency, interval, JSON.stringify(weekdays), recurrenceAnchorDate,
          seriesId, effectiveStartDate, input.endDate, input.startTime,
          input.endTime, duration, input.notes ?? null, actorId,
        ],
      );
      targetSeriesId = createdSeries.rows[0]!.id;
    } else {
      const removed = await client.query(
        `DELETE FROM scheduled_sessions
          WHERE series_id = $1
            AND status = 'pending'
            AND matched_transaction_id IS NULL
            AND session_date >= $2::date`,
        [seriesId, applyFromDate],
      );
      replaced = removed.rowCount ?? 0;
      await client.query(
        `UPDATE schedule_series
            SET employee_id = $2,
                program_id = $3,
                service_type = $4,
                frequency = $5,
                interval = $6,
                weekdays = $7,
                recurrence_anchor_date = $8,
                start_date = $9,
                end_date = $10,
                start_time = $11,
                end_time = $12,
                duration_hours = $13,
                status = $14,
                notes = $15,
                updated_at = now()
          WHERE id = $1`,
        [
          seriesId, input.employeeId, input.programId, input.serviceType ?? null,
          input.frequency, interval, JSON.stringify(weekdays), recurrenceAnchorDate,
          input.startDate, input.endDate, input.startTime, input.endTime, duration,
          input.status, input.notes ?? null,
        ],
      );
      await client.query(`DELETE FROM schedule_series_individuals WHERE series_id = $1`, [seriesId]);
    }
    for (const individualId of individualIds) {
      await client.query(
        `INSERT INTO schedule_series_individuals (series_id, individual_id) VALUES ($1, $2)`,
        [targetSeriesId, individualId],
      );
    }

    const dates = candidateDates.filter((date) => !protectedFutureDates.has(date));
    let warnings = 0;
    for (const sessionDate of dates) {
      const result = await insertSessionRows(
        client,
        {
          ...input,
          individualIds,
          sessionDate,
          seriesId: targetSeriesId,
          source: "recurring",
          durationHours: duration,
          overrideReason,
        },
        actorId,
      );
      warnings += plannerWarnings(result.warnings).length;
    }
    if (warnings > 0 && !overrideReason) {
      await client.query("ROLLBACK");
      return fail("validation", SCHEDULE_OVERRIDE_REQUIRED_MESSAGE);
    }

    const preserved = Number(preservedRows[0]?.count ?? 0);
    const previous = {
      employeeId: current.employee_id,
      programId: current.program_id,
      serviceType: current.service_type,
      frequency: current.frequency,
      interval: current.interval,
      weekdays: current.weekdays,
      recurrenceAnchorDate: current.recurrence_anchor_date,
      startDate: current.start_date,
      endDate: current.end_date,
      startTime: current.start_time,
      endTime: current.end_time,
      durationHours: current.duration_hours,
      status: current.status,
      notes: current.notes,
      individualIds: previousIndividualIds,
    };
    const next = {
      employeeId: input.employeeId,
      programId: input.programId,
      serviceType: input.serviceType ?? null,
      frequency: input.frequency,
      interval,
      weekdays,
      recurrenceAnchorDate,
      startDate: split ? effectiveStartDate : input.startDate,
      endDate: input.endDate,
      startTime: input.startTime,
      endTime: input.endTime,
      durationHours: duration,
      status: input.status,
      notes: input.notes ?? null,
      individualIds,
    };
    const auditExtra = {
      applyFromDate,
      previousSeriesId: split ? seriesId : null,
      newSeriesId: targetSeriesId,
      replaced,
      created: dates.length,
      preserved,
      warnings,
    };
    if (split) {
      await recordChange(client, {
        actorId,
        action: "series_split",
        entityType: "schedule_series",
        entityId: seriesId,
        previous: { endDate: current.end_date, status: current.status },
        next: { endDate: oldEndDate, status: oldStatus, successorSeriesId: targetSeriesId },
        reason: overrideReason,
        extra: auditExtra,
      });
      await recordChange(client, {
        actorId,
        action: "series_version_created",
        entityType: "schedule_series",
        entityId: targetSeriesId,
        previous,
        next,
        reason: overrideReason,
        extra: auditExtra,
      });
    } else {
      await recordChange(client, {
        actorId,
        action: "series_updated",
        entityType: "schedule_series",
        entityId: seriesId,
        previous,
        next,
        reason: overrideReason,
        extra: auditExtra,
      });
    }
    await client.query("COMMIT");
    return ok({
      seriesId: targetSeriesId,
      previousSeriesId: split ? seriesId : null,
      split,
      applyFromDate,
      replaced,
      created: dates.length,
      preserved,
      warnings,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isLiveSuccessorConflict(error)) return fail("conflict", EXISTING_SUCCESSOR_MESSAGE);
    return fail("validation", scheduleSaveMessage(error, "Could not update the recurring schedule. Try again."));
  } finally {
    client.release();
  }
}

export async function setSessionStatus(
  pool: PgLikePool,
  id: string,
  status: "pending" | "completed" | "cancelled" | "no_show",
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(id)) return fail("not_found", "That session no longer exists.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await client.query<{ status: string; matched_transaction_id: string | null }>(
      `SELECT status, matched_transaction_id FROM scheduled_sessions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!before.rows[0]) {
      await client.query("ROLLBACK");
      return fail("not_found", "That session no longer exists.");
    }
    if (before.rows[0].matched_transaction_id && (status === "cancelled" || status === "no_show")) {
      await client.query("ROLLBACK");
      return fail("immutable", "A matched session must remain pending or completed for reconciliation.");
    }
    await client.query(
      `UPDATE scheduled_sessions SET status = $2, updated_at = now() WHERE id = $1`,
      [id, status],
    );
    await recordChange(client, {
      actorId, action: `session_${status}`, entityType: "scheduled_session", entityId: id,
      previous: { status: before.rows[0].status }, next: { status }, reason,
    });
    await client.query("COMMIT");
    return ok({ id });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return fail("validation", scheduleSaveMessage(error, "Could not update the session status. Try again."));
  } finally {
    client.release();
  }
}

export async function rescheduleSession(
  pool: PgLikePool,
  id: string,
  to: { sessionDate?: string; startTime?: string | null; endTime?: string | null },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string; warnings: ScheduleWarning[] }>> {
  if (!isUuid(id)) return fail("not_found", "That session no longer exists.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      employee_id: string | null; program_id: string; session_date: string;
      start_time: string | null; end_time: string | null; duration_hours: string;
      matched_transaction_id: string | null;
    }>(
      `SELECT employee_id, program_id, session_date::text, start_time, end_time,
              duration_hours::text, matched_transaction_id
         FROM scheduled_sessions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const s = rows[0];
    if (!s) {
      await client.query("ROLLBACK");
      return fail("not_found", "That session no longer exists.");
    }
    if (s.matched_transaction_id) {
      await client.query("ROLLBACK");
      return fail("immutable", "A matched session cannot be rescheduled. Remove its reconciliation match first.");
    }
    const sessionDate = to.sessionDate ?? s.session_date;
    const startTime = to.startTime === undefined ? s.start_time : to.startTime;
    const endTime = to.endTime === undefined ? s.end_time : to.endTime;
    const inds = await client.query<{ individual_id: string }>(
      `SELECT individual_id FROM scheduled_allocations WHERE scheduled_session_id = $1`,
      [id],
    );
    const warnings = await detectConflicts(
      client,
      { employeeId: s.employee_id, programId: s.program_id, individualIds: inds.rows.map((r) => r.individual_id), sessionDate, startTime, endTime, durationHours: s.duration_hours },
      id,
    );
    await client.query(
      `UPDATE scheduled_sessions SET session_date = $2, start_time = $3, end_time = $4,
         warnings = $5, updated_at = now() WHERE id = $1`,
      [id, sessionDate, startTime, endTime, warnings.length ? JSON.stringify(warnings) : null],
    );
    await recordChange(client, {
      actorId, action: "session_rescheduled", entityType: "scheduled_session", entityId: id,
      previous: { date: s.session_date, start: s.start_time }, next: { date: sessionDate, start: startTime }, reason,
    });
    await client.query("COMMIT");
    return ok({ id, warnings });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return fail("validation", scheduleSaveMessage(error, "Could not reschedule the session. Try again."));
  } finally {
    client.release();
  }
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string; today: string }>(
      `SELECT status, CURRENT_DATE::text AS today
         FROM schedule_series
        WHERE id = $1 AND archived_at IS NULL
        FOR UPDATE`,
      [seriesId],
    );
    const series = rows[0];
    if (!series) {
      await client.query("ROLLBACK");
      return fail("not_found", "That series no longer exists.");
    }
    const cancelled = await client.query(
      `UPDATE scheduled_sessions
          SET status = 'cancelled', updated_at = now()
        WHERE series_id = $1
          AND status = 'pending'
          AND matched_transaction_id IS NULL
          AND session_date >= $2::date`,
      [seriesId, series.today],
    );
    await client.query(
      `UPDATE schedule_series SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [seriesId],
    );
    await recordChange(client, {
      actorId,
      action: "series_cancelled",
      entityType: "schedule_series",
      entityId: seriesId,
      previous: { status: series.status },
      next: { status: "cancelled" },
      reason,
      extra: { effectiveDate: series.today, cancelledOccurrences: cancelled.rowCount ?? 0 },
    });
    await client.query("COMMIT");
    return ok({ cancelled: cancelled.rowCount ?? 0 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return fail("validation", scheduleSaveMessage(error, "Could not end the recurring schedule. Try again."));
  } finally {
    client.release();
  }
}
