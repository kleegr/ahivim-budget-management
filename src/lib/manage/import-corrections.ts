import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";

/**
 * Import-correction work-queue.
 *
 * A review surface over import_rows. The original source cells (raw_values) are
 * NEVER overwritten: field corrections are stored as a sparse patch in
 * corrected_values, and matching decisions live in the resolved_*_id columns.
 * Every change is audited (who / when / previous / new / reason). Nothing here
 * rewrites an already-imported financial transaction — it curates the staged
 * rows and the canonical mapping that a re-process would use.
 */

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const REVIEW_STATUSES = new Set(["needs_review", "valid", "invalid", "duplicate", "skipped", "imported"]);

export interface CorrectionRow {
  id: string;
  sourceRowNumber: number;
  sheetName: string;
  status: string;
  correctionStatus: string | null;
  raw: Record<string, unknown>;
  corrected: Record<string, unknown> | null;
  validationErrors: unknown;
  resolvedIndividualId: string | null;
  resolvedEmployeeId: string | null;
  resolvedProgramId: string | null;
  individualName: string | null;
  employeeName: string | null;
  programName: string | null;
  correctionReason: string | null;
}

export interface CorrectionQueueFilter {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
  needingAttention?: boolean;
}

/** Rows in a batch, newest issues first. `needingAttention` limits to the ones a human still has to resolve. */
export async function listCorrectionQueue(
  pool: PgLikePool,
  batchId: string,
  filter: CorrectionQueueFilter = {},
): Promise<{ rows: CorrectionRow[]; total: number }> {
  if (!isUuid(batchId)) return { rows: [], total: 0 };
  const status = REVIEW_STATUSES.has(filter.status ?? "") ? filter.status! : null;
  const search = filter.search?.trim() ? `%${filter.search.trim()}%` : null;
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 300);
  const offset = Math.max(0, filter.offset ?? 0);
  const attention = filter.needingAttention ?? false;

  const where = `WHERE r.import_batch_id = $1
       AND ($2::text IS NULL OR r.status = $2)
       AND ($3::text IS NULL OR r.raw_values::text ILIKE $3)
       AND ($4::boolean IS NOT TRUE OR r.status IN ('needs_review','invalid','duplicate'))`;

  const { rows: countRows } = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM import_rows r ${where}`,
    [batchId, status, search, attention],
  );

  const { rows } = await pool.query<{
    id: string; source_row_number: number; sheet_name: string; status: string;
    correction_status: string | null; raw_values: Record<string, unknown>;
    corrected_values: Record<string, unknown> | null; validation_errors: unknown;
    resolved_individual_id: string | null; resolved_employee_id: string | null; resolved_program_id: string | null;
    individual_name: string | null; employee_name: string | null; program_name: string | null;
    correction_reason: string | null;
  }>(
    `SELECT r.id, r.source_row_number, r.sheet_name, r.status, r.correction_status,
            r.raw_values, r.corrected_values, r.validation_errors,
            r.resolved_individual_id, r.resolved_employee_id, r.resolved_program_id,
            i.display_name AS individual_name, e.display_name AS employee_name, p.name AS program_name,
            r.correction_reason
     FROM import_rows r
     LEFT JOIN individuals i ON i.id = r.resolved_individual_id
     LEFT JOIN employees e ON e.id = r.resolved_employee_id
     LEFT JOIN programs p ON p.id = r.resolved_program_id
     ${where}
     ORDER BY (r.status IN ('needs_review','invalid','duplicate')) DESC, r.source_row_number
     LIMIT $5 OFFSET $6`,
    [batchId, status, search, attention, limit, offset],
  );

  return {
    total: Number(countRows[0]?.c ?? 0),
    rows: rows.map((r) => ({
      id: r.id,
      sourceRowNumber: r.source_row_number,
      sheetName: r.sheet_name,
      status: r.status,
      correctionStatus: r.correction_status,
      raw: r.raw_values ?? {},
      corrected: r.corrected_values,
      validationErrors: r.validation_errors,
      resolvedIndividualId: r.resolved_individual_id,
      resolvedEmployeeId: r.resolved_employee_id,
      resolvedProgramId: r.resolved_program_id,
      individualName: r.individual_name,
      employeeName: r.employee_name,
      programName: r.program_name,
      correctionReason: r.correction_reason,
    })),
  };
}

async function getRow(pool: PgLikePool, rowId: string) {
  const { rows } = await pool.query<{
    id: string; status: string; corrected_values: Record<string, unknown> | null;
    resolved_individual_id: string | null; resolved_employee_id: string | null; resolved_program_id: string | null;
  }>(
    `SELECT id, status, corrected_values, resolved_individual_id, resolved_employee_id, resolved_program_id
     FROM import_rows WHERE id = $1`,
    [rowId],
  );
  return rows[0] ?? null;
}

/** Store a { field: value } correction patch. raw_values is left untouched. */
export async function correctRowFields(
  pool: PgLikePool,
  rowId: string,
  patch: Record<string, unknown>,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(rowId)) return fail("not_found", "That row no longer exists.");
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (typeof k === "string" && k.trim()) cleaned[k.trim()] = v;
  }
  if (Object.keys(cleaned).length === 0) return fail("validation", "Provide at least one field to correct.");
  const before = await getRow(pool, rowId);
  if (!before) return fail("not_found", "That row no longer exists.");

  const merged = { ...(before.corrected_values ?? {}), ...cleaned };
  await pool.query(
    `UPDATE import_rows
       SET corrected_values = $2::jsonb, correction_status = 'corrected',
           corrected_by_user_id = $3, corrected_at = now(), correction_reason = $4, updated_at = now()
     WHERE id = $1`,
    [rowId, JSON.stringify(merged), actorId, reason ?? null],
  );
  await recordChange(pool, {
    actorId, action: "import_row_corrected", entityType: "import_row", entityId: rowId,
    previous: { corrected: before.corrected_values ?? null }, next: { corrected: merged }, reason,
  });
  return ok({ id: rowId });
}

/** Clear all field corrections on a row (matching decisions are left as-is). */
export async function resetRowCorrection(
  pool: PgLikePool,
  rowId: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(rowId)) return fail("not_found", "That row no longer exists.");
  const before = await getRow(pool, rowId);
  if (!before) return fail("not_found", "That row no longer exists.");
  await pool.query(
    `UPDATE import_rows
       SET corrected_values = NULL, correction_status = NULL,
           corrected_by_user_id = $2, corrected_at = now(), correction_reason = $3, updated_at = now()
     WHERE id = $1`,
    [rowId, actorId, reason ?? null],
  );
  await recordChange(pool, {
    actorId, action: "import_row_correction_reset", entityType: "import_row", entityId: rowId,
    previous: { corrected: before.corrected_values ?? null }, reason,
  });
  return ok({ id: rowId });
}

/** Set / change the canonical match for a row. Pass null to clear a field. */
export async function resolveRowMatch(
  pool: PgLikePool,
  rowId: string,
  match: { individualId?: string | null; employeeId?: string | null; programId?: string | null },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(rowId)) return fail("not_found", "That row no longer exists.");
  const before = await getRow(pool, rowId);
  if (!before) return fail("not_found", "That row no longer exists.");

  const setInd = match.individualId !== undefined;
  const setEmp = match.employeeId !== undefined;
  const setProg = match.programId !== undefined;
  for (const [flag, val, label] of [
    [setInd, match.individualId, "individual"],
    [setEmp, match.employeeId, "employee"],
    [setProg, match.programId, "program"],
  ] as const) {
    if (flag && val != null && !isUuid(val)) return fail("validation", `Choose a valid ${label}.`);
  }

  await pool.query(
    `UPDATE import_rows SET
       resolved_individual_id = CASE WHEN $2 THEN $3::uuid ELSE resolved_individual_id END,
       resolved_employee_id   = CASE WHEN $4 THEN $5::uuid ELSE resolved_employee_id END,
       resolved_program_id    = CASE WHEN $6 THEN $7::uuid ELSE resolved_program_id END,
       updated_at = now()
     WHERE id = $1`,
    [
      rowId,
      setInd, match.individualId ?? null,
      setEmp, match.employeeId ?? null,
      setProg, match.programId ?? null,
    ],
  );
  await recordChange(pool, {
    actorId, action: "import_row_rematched", entityType: "import_row", entityId: rowId,
    previous: {
      individualId: before.resolved_individual_id,
      employeeId: before.resolved_employee_id,
      programId: before.resolved_program_id,
    },
    next: match, reason,
  });
  return ok({ id: rowId });
}

/** Change a row's review status (needs_review / valid / invalid / duplicate / skipped). */
export async function setRowReviewStatus(
  pool: PgLikePool,
  rowId: string,
  status: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(rowId)) return fail("not_found", "That row no longer exists.");
  if (!REVIEW_STATUSES.has(status)) return fail("validation", "Unknown status.");
  const before = await getRow(pool, rowId);
  if (!before) return fail("not_found", "That row no longer exists.");
  await pool.query(`UPDATE import_rows SET status = $2, updated_at = now() WHERE id = $1`, [rowId, status]);
  await recordChange(pool, {
    actorId, action: "import_row_status", entityType: "import_row", entityId: rowId,
    previous: { status: before.status }, next: { status }, reason,
  });
  return ok({ id: rowId });
}

/** Bulk: set the same review status on many rows in a batch. */
export async function bulkSetStatus(
  pool: PgLikePool,
  batchId: string,
  rowIds: string[],
  status: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ updated: number }>> {
  if (!isUuid(batchId)) return fail("not_found", "That batch no longer exists.");
  if (!REVIEW_STATUSES.has(status)) return fail("validation", "Unknown status.");
  const ids = (rowIds ?? []).filter(isUuid);
  if (ids.length === 0) return fail("validation", "Select at least one row.");
  const { rowCount } = await pool.query(
    `UPDATE import_rows SET status = $3, updated_at = now()
     WHERE import_batch_id = $1 AND id = ANY($2::uuid[])`,
    [batchId, ids, status],
  );
  await recordChange(pool, {
    actorId, action: "import_rows_bulk_status", entityType: "import_batch", entityId: batchId,
    next: { status, rows: rowCount ?? 0 }, reason,
  });
  return ok({ updated: rowCount ?? 0 });
}

/** Bulk: resolve the same program on many rows in a batch. */
export async function bulkResolveProgram(
  pool: PgLikePool,
  batchId: string,
  rowIds: string[],
  programId: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ updated: number }>> {
  if (!isUuid(batchId)) return fail("not_found", "That batch no longer exists.");
  if (!isUuid(programId)) return fail("validation", "Choose a program.");
  const ids = (rowIds ?? []).filter(isUuid);
  if (ids.length === 0) return fail("validation", "Select at least one row.");
  const prog = await pool.query(`SELECT id FROM programs WHERE id = $1`, [programId]);
  if (!prog.rows[0]) return fail("not_found", "That program no longer exists.");
  const { rowCount } = await pool.query(
    `UPDATE import_rows SET resolved_program_id = $3, updated_at = now()
     WHERE import_batch_id = $1 AND id = ANY($2::uuid[])`,
    [batchId, ids, programId],
  );
  await recordChange(pool, {
    actorId, action: "import_rows_bulk_program", entityType: "import_batch", entityId: batchId,
    next: { programId, rows: rowCount ?? 0 }, reason,
  });
  return ok({ updated: rowCount ?? 0 });
}
