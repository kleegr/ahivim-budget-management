import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";

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

  // No duplicate ACTIVE assignment for the same employee + individual + program.
  const dup = await pool.query(
    `SELECT id FROM assignments
      WHERE employee_id = $1 AND individual_id = $2
        AND (program_id IS NOT DISTINCT FROM $3) AND status = 'active'`,
    [input.employeeId, input.individualId, input.programId ?? null],
  );
  if (dup.rows[0]) {
    return fail("conflict", "That employee is already assigned to this individual for this program.");
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO assignments
       (employee_id, individual_id, program_id, start_date, end_date, allowed_hours, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      input.employeeId,
      input.individualId,
      input.programId ?? null,
      input.startDate || null,
      input.endDate || null,
      input.allowedHours || null,
      input.notes?.trim() || null,
      actorId,
    ],
  );
  const record = await getAssignment(pool, rows[0]!.id);
  await recordChange(pool, {
    actorId,
    action: "assignment_created",
    entityType: "assignment",
    entityId: rows[0]!.id,
    next: record,
    reason,
  });
  return ok(record!);
}

export async function getAssignment(pool: PgLikePool, id: string): Promise<AssignmentRecord | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query<Row>(`${SELECT} WHERE a.id = $1`, [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function updateAssignment(
  pool: PgLikePool,
  id: string,
  input: Partial<AssignmentInput>,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<AssignmentRecord>> {
  const before = await getAssignment(pool, id);
  if (!before) return fail("not_found", "That assignment no longer exists.");
  const { rows } = await pool.query<Row>(
    `UPDATE assignments SET
       start_date = $2, end_date = $3, allowed_hours = $4, notes = $5, updated_at = now()
     WHERE id = $1 RETURNING id`,
    [
      id,
      input.startDate === undefined ? before.startDate : input.startDate || null,
      input.endDate === undefined ? before.endDate : input.endDate || null,
      input.allowedHours === undefined ? before.allowedHours : input.allowedHours || null,
      input.notes === undefined ? before.notes : input.notes?.trim() || null,
    ],
  );
  const after = await getAssignment(pool, rows[0]!.id);
  await recordChange(pool, {
    actorId,
    action: "assignment_updated",
    entityType: "assignment",
    entityId: id,
    previous: before,
    next: after,
    reason,
  });
  return ok(after!);
}

export async function setAssignmentStatus(
  pool: PgLikePool,
  id: string,
  status: "active" | "ended" | "archived",
  actorId: string | null,
  reason?: string | null,
): Promise<Result<AssignmentRecord>> {
  const before = await getAssignment(pool, id);
  if (!before) return fail("not_found", "That assignment no longer exists.");
  const archivedAt = status === "archived" ? "now()" : "NULL";
  await pool.query(
    `UPDATE assignments SET status = $2, archived_at = ${archivedAt}, updated_at = now() WHERE id = $1`,
    [id, status],
  );
  const after = await getAssignment(pool, id);
  await recordChange(pool, {
    actorId,
    action: `assignment_${status}`,
    entityType: "assignment",
    entityId: id,
    previous: { status: before.status },
    next: { status },
    reason,
  });
  return ok(after!);
}

export async function listAssignments(
  pool: PgLikePool,
  by: { employeeId?: string; individualId?: string; includeInactive?: boolean } = {},
): Promise<AssignmentRecord[]> {
  const employeeId = by.employeeId && isUuid(by.employeeId) ? by.employeeId : null;
  const individualId = by.individualId && isUuid(by.individualId) ? by.individualId : null;
  const { rows } = await pool.query<Row>(
    `${SELECT}
     WHERE ($1::uuid IS NULL OR a.employee_id = $1)
       AND ($2::uuid IS NULL OR a.individual_id = $2)
       AND ($3::boolean IS TRUE OR a.status = 'active')
     ORDER BY (a.status <> 'active'), i.display_name, e.display_name`,
    [employeeId, individualId, by.includeInactive ?? false],
  );
  return rows.map(toRecord);
}
