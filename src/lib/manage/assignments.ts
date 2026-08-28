import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { dec, toHours } from "@/lib/money";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { employeeScopeClause, individualScopeClause, type AccessScope } from "@/lib/auth/access";

/** An employee is permitted to serve an individual (optionally for a program). */
export interface AssignmentRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  individualId: string;
  individualName: string;
  programId: string | null;
  programName: string | null;
  startDate: string | null;
  endDate: string | null;
  allowedHours: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  employee_id: string;
  employee_name: string;
  individual_id: string;
  individual_name: string;
  program_id: string | null;
  program_name: string | null;
  start_date: string | null;
  end_date: string | null;
  allowed_hours: string | null;
  status: string;
  notes: string | null;
  created_at: string;
}

const SELECT = `
  SELECT a.id, a.employee_id, e.display_name AS employee_name,
         a.individual_id, i.display_name AS individual_name,
         a.program_id, p.name AS program_name,
         a.start_date::text AS start_date, a.end_date::text AS end_date,
         a.allowed_hours::text AS allowed_hours, a.status, a.notes,
         a.created_at::text AS created_at
  FROM assignments a
  JOIN employees e ON e.id = a.employee_id
  JOIN individuals i ON i.id = a.individual_id
  LEFT JOIN programs p ON p.id = a.program_id`;

const toRecord = (r: Row): AssignmentRecord => ({
  id: r.id,
  employeeId: r.employee_id,
  employeeName: r.employee_name,
  individualId: r.individual_id,
  individualName: r.individual_name,
  programId: r.program_id,
  programName: r.program_name,
  startDate: r.start_date,
  endDate: r.end_date,
  allowedHours: r.allowed_hours,
  status: r.status,
  notes: r.notes,
  createdAt: r.created_at,
});

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

async function inAssignmentTransaction<T>(
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

function assignmentScopeKey(input: {
  employeeId: string;
  individualId: string;
  programId: string | null;
}): string {
  return `assignment:${input.employeeId}:${input.individualId}:${input.programId ?? "no-program"}`;
}

async function lockAssignmentScope(
  client: PgLikeClient,
  input: { employeeId: string; individualId: string; programId: string | null },
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [assignmentScopeKey(input)]);
}

async function hasOverlappingAssignment(
  pool: Queryable,
  input: {
    employeeId: string;
    individualId: string;
    programId: string | null;
    startDate: string | null;
    endDate: string | null;
    excludeId?: string | null;
  },
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT id
       FROM assignments
      WHERE employee_id = $1 AND individual_id = $2
        AND program_id IS NOT DISTINCT FROM $3::uuid
        AND status = 'active' AND archived_at IS NULL
        AND ($6::uuid IS NULL OR id <> $6::uuid)
        AND daterange(
              COALESCE(start_date, '-infinity'::date),
              COALESCE(end_date, 'infinity'::date),
              '[]'
            ) && daterange(
              COALESCE($4::date, '-infinity'::date),
              COALESCE($5::date, 'infinity'::date),
              '[]'
            )
      LIMIT 1`,
    [
      input.employeeId,
      input.individualId,
      input.programId,
      input.startDate,
      input.endDate,
      input.excludeId ?? null,
    ],
  );
  return rows.length > 0;
}

export interface AssignmentInput {
  employeeId: string;
  individualId: string;
  programId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  allowedHours?: string | null;
  notes?: string | null;
}

export async function createAssignment(
  pool: PgLikePool,
  input: AssignmentInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<AssignmentRecord>> {
  if (!isUuid(input.employeeId) || !isUuid(input.individualId)) {
    return fail("validation", "Choose both an employee and an individual.");
  }
  if (input.programId && !isUuid(input.programId)) return fail("validation", "Invalid program.");
  if (input.startDate && input.endDate && input.endDate < input.startDate) {
    return fail("validation", "The end date is before the start date.");
  }
  let allowedHours: string | null = null;
  if (input.allowedHours !== null && input.allowedHours !== undefined && input.allowedHours !== "") {
    try {
      const value = dec(input.allowedHours);
      if (!value.isFinite() || value.isNegative()) throw new Error("invalid hours");
      allowedHours = toHours(value);
    } catch {
      return fail("validation", "Allowed hours must be zero or greater.");
    }
  }

  const assignmentInput = {
    employeeId: input.employeeId,
    individualId: input.individualId,
    programId: input.programId ?? null,
    startDate: input.startDate || null,
    endDate: input.endDate || null,
  };
  return inAssignmentTransaction(pool, async (client) => {
    await lockAssignmentScope(client, assignmentInput);
    if (await hasOverlappingAssignment(client, assignmentInput)) {
      return fail("conflict", "That employee already has an overlapping assignment for this individual and program.");
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO assignments
         (employee_id, individual_id, program_id, start_date, end_date, allowed_hours, notes, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.employeeId,
        input.individualId,
        input.programId ?? null,
        input.startDate || null,
        input.endDate || null,
        allowedHours,
        input.notes?.trim() || null,
        actorId,
      ],
    );
    const record = await getAssignment(client, rows[0]!.id);
    await recordChange(client, {
      actorId,
      action: "assignment_created",
      entityType: "assignment",
      entityId: rows[0]!.id,
      next: record,
      reason,
    });
    return ok(record!);
  });
}

export async function getAssignment(
  pool: Queryable,
  id: string,
  lock = false,
): Promise<AssignmentRecord | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query<Row>(
    `${SELECT} WHERE a.id = $1${lock ? " FOR UPDATE OF a" : ""}`,
    [id],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function updateAssignment(
  pool: PgLikePool,
  id: string,
  input: Partial<AssignmentInput>,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<AssignmentRecord>> {
  return inAssignmentTransaction(pool, async (client) => {
    const scope = await getAssignment(client, id);
    if (!scope) return fail("not_found", "That assignment no longer exists.");
    await lockAssignmentScope(client, scope);
    const before = await getAssignment(client, id, true);
    if (!before) return fail("not_found", "That assignment no longer exists.");

    const startDate = input.startDate === undefined ? before.startDate : input.startDate || null;
    const endDate = input.endDate === undefined ? before.endDate : input.endDate || null;
    if (startDate && endDate && endDate < startDate) {
      return fail("validation", "The end date is before the start date.");
    }
    let allowedHours = before.allowedHours;
    if (input.allowedHours !== undefined) {
      if (input.allowedHours === null || input.allowedHours === "") {
        allowedHours = null;
      } else {
        try {
          const value = dec(input.allowedHours);
          if (!value.isFinite() || value.isNegative()) throw new Error("invalid hours");
          allowedHours = toHours(value);
        } catch {
          return fail("validation", "Allowed hours must be zero or greater.");
        }
      }
    }
    if (await hasOverlappingAssignment(client, {
      employeeId: before.employeeId,
      individualId: before.individualId,
      programId: before.programId,
      startDate,
      endDate,
      excludeId: id,
    })) {
      return fail("conflict", "Those dates overlap another active assignment for this employee, individual, and program.");
    }
    const { rows } = await client.query<Row>(
      `UPDATE assignments SET
         start_date = $2, end_date = $3, allowed_hours = $4, notes = $5, updated_at = now()
       WHERE id = $1 RETURNING id`,
      [
        id,
        startDate,
        endDate,
        allowedHours,
        input.notes === undefined ? before.notes : input.notes?.trim() || null,
      ],
    );
    const after = await getAssignment(client, rows[0]!.id);
    await recordChange(client, {
      actorId,
      action: "assignment_updated",
      entityType: "assignment",
      entityId: id,
      previous: before,
      next: after,
      reason,
    });
    return ok(after!);
  });
}

export async function setAssignmentStatus(
  pool: PgLikePool,
  id: string,
  status: "active" | "ended" | "archived",
  actorId: string | null,
  reason?: string | null,
): Promise<Result<AssignmentRecord>> {
  return inAssignmentTransaction(pool, async (client) => {
    const scope = await getAssignment(client, id);
    if (!scope) return fail("not_found", "That assignment no longer exists.");
    await lockAssignmentScope(client, scope);
    const before = await getAssignment(client, id, true);
    if (!before) return fail("not_found", "That assignment no longer exists.");

    if (status === "active" && before.status !== "active" && await hasOverlappingAssignment(client, {
      employeeId: before.employeeId,
      individualId: before.individualId,
      programId: before.programId,
      startDate: before.startDate,
      endDate: before.endDate,
      excludeId: id,
    })) {
      return fail("conflict", "This assignment overlaps another active assignment and cannot be restored.");
    }
    const archivedAt = status === "archived" ? "now()" : "NULL";
    await client.query(
      `UPDATE assignments SET status = $2, archived_at = ${archivedAt}, updated_at = now() WHERE id = $1`,
      [id, status],
    );
    const after = await getAssignment(client, id);
    await recordChange(client, {
      actorId,
      action: `assignment_${status}`,
      entityType: "assignment",
      entityId: id,
      previous: { status: before.status },
      next: { status },
      reason,
    });
    return ok(after!);
  });
}

export async function listAssignments(
  pool: PgLikePool,
  by: { employeeId?: string; individualId?: string; includeInactive?: boolean; scope?: AccessScope; hoursOnlyPrograms?: boolean } = {},
): Promise<AssignmentRecord[]> {
  const employeeId = by.employeeId && isUuid(by.employeeId) ? by.employeeId : null;
  const individualId = by.individualId && isUuid(by.individualId) ? by.individualId : null;
  const params: unknown[] = [employeeId, individualId, by.includeInactive ?? false, by.hoursOnlyPrograms ?? false];
  const employeeClause = by.scope ? employeeScopeClause(by.scope, "a.employee_id", params) : "";
  const individualClause = by.scope ? individualScopeClause(by.scope, "a.individual_id", params) : "";
  const { rows } = await pool.query<Row>(
    `${SELECT}
     WHERE ($1::uuid IS NULL OR a.employee_id = $1)
       AND ($2::uuid IS NULL OR a.individual_id = $2)
       AND ($3::boolean IS TRUE OR a.status = 'active')
       AND ($4::boolean IS NOT TRUE OR a.program_id IS NULL OR (
         p.required_auth_type <> 'dollars'
         AND p.consumption_source IN ('payroll', 'mixed')
       ))${employeeClause}${individualClause}
     ORDER BY (a.status <> 'active'), i.display_name, e.display_name`,
    params,
  );
  return rows.map(toRecord);
}
