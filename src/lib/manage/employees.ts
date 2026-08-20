import type { PgLikePool } from "@/lib/import/commit";
import { normalizePersonName } from "@/lib/business/name-matching";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { employeeScopeClause, type AccessScope } from "@/lib/auth/access";

export const EMPLOYEE_STATUSES = ["active", "inactive", "archived"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export interface EmployeeRecord {
  id: string;
  displayName: string;
  normalizedName: string;
  externalRef: string | null;
  status: string;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  display_name: string;
  normalized_name: string;
  external_ref: string | null;
  status: string;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
}

const COLS = `id, display_name, normalized_name, external_ref, status, notes,
              archived_at::text AS archived_at, created_at::text AS created_at`;

const toRecord = (r: Row): EmployeeRecord => ({
  id: r.id,
  displayName: r.display_name,
  normalizedName: r.normalized_name,
  externalRef: r.external_ref,
  status: r.status,
  notes: r.notes,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
});

export async function getEmployee(pool: PgLikePool, id: string): Promise<EmployeeRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM employees WHERE id = $1`, [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface EmployeeInput {
  displayName: string;
  externalRef?: string | null;
  status?: string;
  notes?: string | null;
}

export async function createEmployee(
  pool: PgLikePool,
  input: EmployeeInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<EmployeeRecord>> {
  const displayName = input.displayName?.trim();
  if (!displayName) return fail("validation", "A name is required.");
  const normalized = normalizePersonName(displayName);
  if (!normalized) return fail("validation", "That name normalises to nothing usable.");

  const existing = await pool.query(`SELECT id FROM employees WHERE normalized_name = $1`, [
    normalized,
  ]);
  if (existing.rows[0]) {
    return fail("conflict", "An employee with this name already exists. Open that record instead.");
  }
  const status = EMPLOYEE_STATUSES.includes(input.status as EmployeeStatus) ? input.status! : "active";

  const { rows } = await pool.query<Row>(
    `INSERT INTO employees (display_name, normalized_name, external_ref, status, notes)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
    [displayName, normalized, input.externalRef?.trim() || null, status, input.notes?.trim() || null],
  );
  const record = toRecord(rows[0]!);
  await recordChange(pool, {
    actorId,
    action: "employee_created",
    entityType: "employee",
    entityId: record.id,
    next: record,
    reason,
  });
  return ok(record);
}

export async function updateEmployee(
  pool: PgLikePool,
  id: string,
  input: EmployeeInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<EmployeeRecord>> {
  const before = await getEmployee(pool, id);
  if (!before) return fail("not_found", "That employee no longer exists.");
  const displayName = input.displayName?.trim() || before.displayName;
  const normalized = normalizePersonName(displayName);
  if (!normalized) return fail("validation", "That name normalises to nothing usable.");
  if (normalized !== before.normalizedName) {
    const clash = await pool.query(
      `SELECT id FROM employees WHERE normalized_name = $1 AND id <> $2`,
      [normalized, id],
    );
    if (clash.rows[0]) return fail("conflict", "Another employee already uses that name.");
  }
  if (input.status && !EMPLOYEE_STATUSES.includes(input.status as EmployeeStatus)) {
    return fail("validation", "Unknown status.");
  }

  const { rows } = await pool.query<Row>(
    `UPDATE employees SET display_name = $2, normalized_name = $3, external_ref = $4,
       status = COALESCE($5, status), notes = $6, updated_at = now()
     WHERE id = $1 RETURNING ${COLS}`,
    [
      id,
      displayName,
      normalized,
      input.externalRef === undefined ? before.externalRef : input.externalRef?.trim() || null,
      input.status ?? null,
      input.notes === undefined ? before.notes : input.notes?.trim() || null,
    ],
  );
  const after = toRecord(rows[0]!);
  await recordChange(pool, {
    actorId,
    action: "employee_updated",
    entityType: "employee",
    entityId: id,
    previous: before,
    next: after,
    reason,
  });
  return ok(after);
}

export async function setEmployeeStatus(
  pool: PgLikePool,
  id: string,
  status: EmployeeStatus,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<EmployeeRecord>> {
  const before = await getEmployee(pool, id);
  if (!before) return fail("not_found", "That employee no longer exists.");
  if (!EMPLOYEE_STATUSES.includes(status)) return fail("validation", "Unknown status.");
  const archivedAt = status === "archived" ? "now()" : "NULL";
  const { rows } = await pool.query<Row>(
    `UPDATE employees SET status = $2, archived_at = ${archivedAt}, updated_at = now()
     WHERE id = $1 RETURNING ${COLS}`,
    [id, status],
  );
  const after = toRecord(rows[0]!);
  await recordChange(pool, {
    actorId,
    action: status === "archived" ? "employee_archived" : "employee_status_changed",
    entityType: "employee",
    entityId: id,
    previous: { status: before.status },
    next: { status },
    reason,
  });
  return ok(after);
}

export async function listEmployeesManaged(
  pool: PgLikePool,
  filter: { status?: string; search?: string; includeArchived?: boolean; scope?: AccessScope } = {},
): Promise<EmployeeRecord[]> {
  const status = EMPLOYEE_STATUSES.includes(filter.status as EmployeeStatus) ? filter.status! : null;
  const search = filter.search?.trim() ? `%${filter.search.trim()}%` : null;
  const params: unknown[] = [status, filter.includeArchived ?? false, search];
  const scopeClause = filter.scope ? employeeScopeClause(filter.scope, "id", params) : "";
  const { rows } = await pool.query<Row>(
    `SELECT ${COLS} FROM employees
     WHERE ($1::text IS NULL OR status = $1)
       AND ($2::boolean IS TRUE OR status <> 'archived')
       AND ($3::text IS NULL OR display_name ILIKE $3 OR external_ref ILIKE $3)${scopeClause}
     ORDER BY (status = 'archived'), display_name`,
    params,
  );
  return rows.map(toRecord);
}
