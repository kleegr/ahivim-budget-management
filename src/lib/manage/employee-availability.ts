import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { fail, ok, type Result } from "./errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

export interface WeeklyAvailabilityWindow {
  id: string;
  kind: "weekly";
  employeeId: string;
  employeeName: string;
  weekday: number;
  startTime: string;
  endTime: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface EmployeeUnavailabilityWindow {
  id: string;
  kind: "unavailable";
  employeeId: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  label: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface EmployeeAvailabilityRules {
  weekly: WeeklyAvailabilityWindow[];
  unavailable: EmployeeUnavailabilityWindow[];
  scheduleConflicts: EmployeeAvailabilitySessionConflict[];
}

export interface EmployeeAvailabilitySessionConflict {
  id: string;
  sessionDate: string;
  startTime: string | null;
  endTime: string | null;
  durationHours: string;
  programName: string;
  individualNames: string[];
}

export interface WeeklyAvailabilityInput {
  employeeId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
}

export interface EmployeeUnavailabilityInput {
  employeeId: string;
  startDate: string;
  endDate: string;
  startTime?: string | null;
  endTime?: string | null;
  label?: string | null;
}

interface WeeklyRow {
  id: string;
  employee_id: string;
  employee_name: string;
  weekday: number;
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
}

interface UnavailabilityRow {
  id: string;
  employee_id: string;
  employee_name: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  label: string | null;
  archived_at: string | null;
  created_at: string;
}

interface AvailabilityConflictRow {
  id: string;
  session_date: string;
  start_time: string | null;
  end_time: string | null;
  duration_hours: string;
  program_name: string;
  individual_names: string[] | null;
}

const WEEKLY_SELECT = `
  SELECT availability.id, availability.employee_id,
         employee.display_name AS employee_name,
         availability.weekday, availability.start_time, availability.end_time,
         availability.effective_from::text, availability.effective_to::text,
         availability.notes, availability.archived_at::text,
         availability.created_at::text
    FROM employee_weekly_availability availability
    JOIN employees employee ON employee.id = availability.employee_id`;

const UNAVAILABLE_SELECT = `
  SELECT unavailable.id, unavailable.employee_id,
         employee.display_name AS employee_name,
         unavailable.start_date::text, unavailable.end_date::text,
         unavailable.start_time, unavailable.end_time, unavailable.label,
         unavailable.archived_at::text, unavailable.created_at::text
    FROM employee_unavailability unavailable
    JOIN employees employee ON employee.id = unavailable.employee_id`;

const toWeekly = (row: WeeklyRow): WeeklyAvailabilityWindow => ({
  id: row.id,
  kind: "weekly",
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  weekday: row.weekday,
  startTime: row.start_time,
  endTime: row.end_time,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  notes: row.notes,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
});

const toUnavailable = (row: UnavailabilityRow): EmployeeUnavailabilityWindow => ({
  id: row.id,
  kind: "unavailable",
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  startDate: row.start_date,
  endDate: row.end_date,
  startTime: row.start_time,
  endTime: row.end_time,
  label: row.label,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
});

function isDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function optionalText(value: string | null | undefined, max: number): Result<string | null> {
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > max) {
    return fail("validation", `Keep the note under ${max} characters.`);
  }
  return ok(normalized);
}

async function inTransaction<T>(
  pool: PgLikePool,
  operation: (client: PgLikeClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function activeEmployeeExists(db: Queryable, employeeId: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM employees
      WHERE id = $1 AND status = 'active' AND archived_at IS NULL`,
    [employeeId],
  );
  return rows.length > 0;
}

export async function listEmployeeAvailabilityRules(
  pool: Queryable,
  options: {
    employeeId?: string | null;
    employeeIds?: string[] | null;
    from?: string | null;
    to?: string | null;
    reviewFrom?: string | null;
    conflictAgencyIds?: string[] | null;
    includeArchived?: boolean;
  } = {},
): Promise<EmployeeAvailabilityRules> {
  const empty = { weekly: [], unavailable: [], scheduleConflicts: [] };
  if (options.employeeId && !UUID_RE.test(options.employeeId)) return empty;
  if (options.employeeIds && options.employeeIds.some((id) => !UUID_RE.test(id))) {
    return empty;
  }
  if (options.conflictAgencyIds?.some((id) => !UUID_RE.test(id))) return empty;
  if (options.employeeIds?.length === 0) return empty;
  if ((options.from && !isDate(options.from)) || (options.to && !isDate(options.to))
      || (options.reviewFrom && !isDate(options.reviewFrom))) {
    return empty;
  }
  if (options.from && options.to && options.to < options.from) return empty;

  const params: unknown[] = [
    options.employeeId ?? null,
    options.employeeIds ?? null,
    options.includeArchived ?? false,
    options.from ?? null,
    options.to ?? null,
  ];
  const [weekly, unavailable, scheduleConflicts] = await Promise.all([
    pool.query<WeeklyRow>(
      `${WEEKLY_SELECT}
       WHERE ($1::uuid IS NULL OR availability.employee_id = $1)
         AND ($2::uuid[] IS NULL OR availability.employee_id = ANY($2::uuid[]))
         AND ($3::boolean IS TRUE OR availability.archived_at IS NULL)
         AND ($5::date IS NULL OR availability.effective_from <= $5::date)
         AND ($4::date IS NULL OR availability.effective_to IS NULL OR availability.effective_to >= $4::date)
       ORDER BY employee.display_name, availability.weekday,
                availability.start_time, availability.effective_from`,
      params,
    ),
    pool.query<UnavailabilityRow>(
      `${UNAVAILABLE_SELECT}
       WHERE ($1::uuid IS NULL OR unavailable.employee_id = $1)
         AND ($2::uuid[] IS NULL OR unavailable.employee_id = ANY($2::uuid[]))
         AND ($3::boolean IS TRUE OR unavailable.archived_at IS NULL)
         AND ($5::date IS NULL OR unavailable.start_date <= $5::date)
         AND ($4::date IS NULL OR unavailable.end_date >= $4::date)
       ORDER BY employee.display_name, unavailable.start_date,
                unavailable.start_time NULLS FIRST`,
      params,
    ),
    pool.query<AvailabilityConflictRow>(
      `SELECT scheduled.id, scheduled.session_date::text AS session_date,
              scheduled.start_time, scheduled.end_time,
              scheduled.duration_hours::text AS duration_hours,
              program.name AS program_name,
              COALESCE(
                array_agg(individual.display_name::text ORDER BY individual.display_name)
                  FILTER (WHERE individual.id IS NOT NULL),
                ARRAY[]::text[]
              ) AS individual_names
         FROM scheduled_sessions scheduled
         JOIN programs program ON program.id = scheduled.program_id
         LEFT JOIN scheduled_allocations allocation ON allocation.scheduled_session_id = scheduled.id
         LEFT JOIN individuals individual ON individual.id = allocation.individual_id
        WHERE ($1::uuid IS NULL OR scheduled.employee_id = $1)
          AND ($2::uuid[] IS NULL OR scheduled.employee_id = ANY($2::uuid[]))
          AND scheduled.status = 'pending'
          AND scheduled.matched_transaction_id IS NULL
          AND scheduled.archived_at IS NULL
          AND ($3::date IS NULL OR scheduled.session_date >= $3::date)
          AND ($4::uuid[] IS NULL OR EXISTS (
            SELECT 1
              FROM unnest($4::uuid[]) permitted(agency_id)
             WHERE EXISTS (
               SELECT 1
                 FROM scheduled_allocations participant
                WHERE participant.scheduled_session_id = scheduled.id
             )
               AND NOT EXISTS (
                 SELECT 1
                   FROM scheduled_allocations participant
                  WHERE participant.scheduled_session_id = scheduled.id
                    AND NOT EXISTS (
                      SELECT 1
                        FROM agency_individuals membership
                       WHERE membership.agency_id = permitted.agency_id
                         AND membership.individual_id = participant.individual_id
                         AND membership.is_active = true
                         AND membership.effective_from <= scheduled.session_date
                         AND (membership.effective_to IS NULL OR membership.effective_to >= scheduled.session_date)
                    )
               )
               AND scheduled.employee_id IS NOT NULL
               AND EXISTS (
                 SELECT 1
                   FROM agency_employees membership
                  WHERE membership.agency_id = permitted.agency_id
                    AND membership.employee_id = scheduled.employee_id
                    AND membership.is_active = true
                    AND membership.effective_from <= scheduled.session_date
                    AND (membership.effective_to IS NULL OR membership.effective_to >= scheduled.session_date)
               )
          ))
          AND EXISTS (
            SELECT 1
              FROM employee_unavailability unavailable
             WHERE unavailable.employee_id = scheduled.employee_id
               AND unavailable.archived_at IS NULL
               AND scheduled.session_date BETWEEN unavailable.start_date AND unavailable.end_date
               AND (
                 unavailable.start_time IS NULL OR unavailable.end_time IS NULL
                 OR scheduled.start_time IS NULL OR scheduled.end_time IS NULL
                 OR (scheduled.start_time < unavailable.end_time AND unavailable.start_time < scheduled.end_time)
               )
          )
        GROUP BY scheduled.id, program.name
        ORDER BY scheduled.session_date, scheduled.start_time NULLS FIRST, scheduled.id
        LIMIT 100`,
      [
        options.employeeId ?? null,
        options.employeeIds ?? null,
        options.reviewFrom ?? null,
        options.conflictAgencyIds ?? null,
      ],
    ),
  ]);
  return {
    weekly: weekly.rows.map(toWeekly),
    unavailable: unavailable.rows.map(toUnavailable),
    scheduleConflicts: scheduleConflicts.rows.map((row) => ({
      id: row.id,
      sessionDate: row.session_date,
      startTime: row.start_time,
      endTime: row.end_time,
      durationHours: row.duration_hours,
      programName: row.program_name,
      individualNames: row.individual_names ?? [],
    })),
  };
}

export async function getWeeklyAvailabilityWindow(
  db: Queryable,
  id: string,
  lock = false,
): Promise<WeeklyAvailabilityWindow | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query<WeeklyRow>(
    `${WEEKLY_SELECT} WHERE availability.id = $1${lock ? " FOR UPDATE OF availability" : ""}`,
    [id],
  );
  return rows[0] ? toWeekly(rows[0]) : null;
}

export async function getEmployeeUnavailabilityWindow(
  db: Queryable,
  id: string,
  lock = false,
): Promise<EmployeeUnavailabilityWindow | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query<UnavailabilityRow>(
    `${UNAVAILABLE_SELECT} WHERE unavailable.id = $1${lock ? " FOR UPDATE OF unavailable" : ""}`,
    [id],
  );
  return rows[0] ? toUnavailable(rows[0]) : null;
}

export async function createWeeklyAvailabilityWindow(
  pool: PgLikePool,
  input: WeeklyAvailabilityInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<WeeklyAvailabilityWindow>> {
  if (!UUID_RE.test(input.employeeId)) return fail("validation", "Choose an employee.");
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
    return fail("validation", "Choose a weekday.");
  }
  if (!TIME_RE.test(input.startTime) || !TIME_RE.test(input.endTime) || input.endTime <= input.startTime) {
    return fail("validation", "Choose a valid start and end time.");
  }
  if (!isDate(input.effectiveFrom) || (input.effectiveTo && !isDate(input.effectiveTo))) {
    return fail("validation", "Choose valid effective dates.");
  }
  const effectiveTo = input.effectiveTo || null;
  if (effectiveTo && effectiveTo < input.effectiveFrom) {
    return fail("validation", "The effective end date is before the start date.");
  }
  const notes = optionalText(input.notes, 500);
  if (!notes.ok) return notes;

  return inTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`employee-availability:${input.employeeId}`]);
    if (!await activeEmployeeExists(client, input.employeeId)) {
      return fail("not_found", "That active employee no longer exists.");
    }
    const duplicate = await client.query<{ id: string }>(
      `SELECT id FROM employee_weekly_availability
        WHERE employee_id = $1 AND weekday = $2
          AND start_time = $3 AND end_time = $4
          AND effective_from = $5 AND effective_to IS NOT DISTINCT FROM $6::date
          AND archived_at IS NULL
        LIMIT 1`,
      [input.employeeId, input.weekday, input.startTime, input.endTime, input.effectiveFrom, effectiveTo],
    );
    if (duplicate.rows.length > 0) return fail("conflict", "That availability window already exists.");

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO employee_weekly_availability
         (employee_id, weekday, start_time, end_time, effective_from, effective_to,
          notes, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.employeeId,
        input.weekday,
        input.startTime,
        input.endTime,
        input.effectiveFrom,
        effectiveTo,
        notes.data,
        actorId,
      ],
    );
    const created = await getWeeklyAvailabilityWindow(client, rows[0]!.id);
    await recordChange(client, {
      actorId,
      action: "employee_weekly_availability_created",
      entityType: "employee_weekly_availability",
      entityId: rows[0]!.id,
      next: created,
      reason,
    });
    return ok(created!);
  });
}

export async function createEmployeeUnavailabilityWindow(
  pool: PgLikePool,
  input: EmployeeUnavailabilityInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<EmployeeUnavailabilityWindow>> {
  if (!UUID_RE.test(input.employeeId)) return fail("validation", "Choose an employee.");
  if (!isDate(input.startDate) || !isDate(input.endDate) || input.endDate < input.startDate) {
    return fail("validation", "Choose a valid date range.");
  }
  const startTime = input.startTime || null;
  const endTime = input.endTime || null;
  if ((startTime === null) !== (endTime === null)) {
    return fail("validation", "Enter both times, or leave both blank for the full day.");
  }
  if (startTime && (!TIME_RE.test(startTime) || !TIME_RE.test(endTime!) || endTime! <= startTime)) {
    return fail("validation", "Choose a valid start and end time.");
  }
  if (startTime && input.startDate !== input.endDate) {
    return fail("validation", "Timed unavailable entries must be for one day. Use full day for a date range.");
  }
  const label = optionalText(input.label, 200);
  if (!label.ok) return label;

  return inTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`employee-availability:${input.employeeId}`]);
    if (!await activeEmployeeExists(client, input.employeeId)) {
      return fail("not_found", "That active employee no longer exists.");
    }
    const duplicate = await client.query<{ id: string }>(
      `SELECT id FROM employee_unavailability
        WHERE employee_id = $1 AND start_date = $2 AND end_date = $3
          AND start_time IS NOT DISTINCT FROM $4::text
          AND end_time IS NOT DISTINCT FROM $5::text
          AND archived_at IS NULL
        LIMIT 1`,
      [input.employeeId, input.startDate, input.endDate, startTime, endTime],
    );
    if (duplicate.rows.length > 0) return fail("conflict", "That unavailable time already exists.");

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO employee_unavailability
         (employee_id, start_date, end_date, start_time, end_time, label, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [input.employeeId, input.startDate, input.endDate, startTime, endTime, label.data, actorId],
    );
    const created = await getEmployeeUnavailabilityWindow(client, rows[0]!.id);
    await recordChange(client, {
      actorId,
      action: "employee_unavailability_created",
      entityType: "employee_unavailability",
      entityId: rows[0]!.id,
      next: created,
      reason,
    });
    return ok(created!);
  });
}

export async function archiveWeeklyAvailabilityWindow(
  pool: PgLikePool,
  id: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<WeeklyAvailabilityWindow>> {
  return inTransaction(pool, async (client) => {
    const scope = await getWeeklyAvailabilityWindow(client, id);
    if (!scope) return fail("not_found", "That availability window no longer exists.");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`employee-availability:${scope.employeeId}`]);
    const before = await getWeeklyAvailabilityWindow(client, id, true);
    if (!before) return fail("not_found", "That availability window no longer exists.");
    if (before.archivedAt) return fail("conflict", "That availability window is already archived.");
    await client.query(
      `UPDATE employee_weekly_availability
          SET archived_at = now(), archived_by_user_id = $2, updated_at = now()
        WHERE id = $1`,
      [id, actorId],
    );
    const after = await getWeeklyAvailabilityWindow(client, id);
    await recordChange(client, {
      actorId,
      action: "employee_weekly_availability_archived",
      entityType: "employee_weekly_availability",
      entityId: id,
      previous: before,
      next: after,
      reason,
    });
    return ok(after!);
  });
}

export async function archiveEmployeeUnavailabilityWindow(
  pool: PgLikePool,
  id: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<EmployeeUnavailabilityWindow>> {
  return inTransaction(pool, async (client) => {
    const scope = await getEmployeeUnavailabilityWindow(client, id);
    if (!scope) return fail("not_found", "That unavailable time no longer exists.");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`employee-availability:${scope.employeeId}`]);
    const before = await getEmployeeUnavailabilityWindow(client, id, true);
    if (!before) return fail("not_found", "That unavailable time no longer exists.");
    if (before.archivedAt) return fail("conflict", "That unavailable time is already archived.");
    await client.query(
      `UPDATE employee_unavailability
          SET archived_at = now(), archived_by_user_id = $2, updated_at = now()
        WHERE id = $1`,
      [id, actorId],
    );
    const after = await getEmployeeUnavailabilityWindow(client, id);
    await recordChange(client, {
      actorId,
      action: "employee_unavailability_archived",
      entityType: "employee_unavailability",
      entityId: id,
      previous: before,
      next: after,
      reason,
    });
    return ok(after!);
  });
}
