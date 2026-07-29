import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { toMoney } from "@/lib/money";

export interface ProgramRecord {
  id: string;
  code: string;
  name: string;
  isGroupCapable: boolean;
  isActive: boolean;
  notes: string | null;
  archivedAt: string | null;
}

interface Row {
  id: string;
  code: string;
  name: string;
  is_group_capable: boolean;
  is_active: boolean;
  notes: string | null;
  archived_at: string | null;
}

const COLS = `id, code, name, is_group_capable, is_active, notes, archived_at::text AS archived_at`;
const toRecord = (r: Row): ProgramRecord => ({
  id: r.id,
  code: r.code,
  name: r.name,
  isGroupCapable: r.is_group_capable,
  isActive: r.is_active,
  notes: r.notes,
  archivedAt: r.archived_at,
});

export async function getProgram(pool: PgLikePool, id: string): Promise<ProgramRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM programs WHERE id = $1`, [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface ProgramInput {
  code: string;
  name: string;
  isGroupCapable?: boolean;
  notes?: string | null;
}

export async function createProgram(
  pool: PgLikePool,
  input: ProgramInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<ProgramRecord>> {
  const code = input.code?.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const name = input.name?.trim();
  if (!code) return fail("validation", "A short program code is required.");
  if (!name) return fail("validation", "A program name is required.");
  const dup = await pool.query(`SELECT id FROM programs WHERE code = $1`, [code]);
  if (dup.rows[0]) return fail("conflict", "A program with that code already exists.");

  const { rows } = await pool.query<Row>(
    `INSERT INTO programs (code, name, is_group_capable, notes)
     VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
    [code, name, input.isGroupCapable ?? false, input.notes?.trim() || null],
  );
  const record = toRecord(rows[0]!);
  await recordChange(pool, {
    actorId,
    action: "program_created",
    entityType: "program",
    entityId: record.id,
    next: record,
    reason,
  });
  return ok(record);
}

export async function updateProgram(
  pool: PgLikePool,
  id: string,
  input: Partial<ProgramInput> & { isActive?: boolean },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<ProgramRecord>> {
  const before = await getProgram(pool, id);
  if (!before) return fail("not_found", "That program no longer exists.");
  const { rows } = await pool.query<Row>(
    `UPDATE programs SET
       name = COALESCE($2, name),
       is_group_capable = COALESCE($3, is_group_capable),
       is_active = COALESCE($4, is_active),
       notes = $5,
       archived_at = CASE WHEN $4 IS FALSE THEN now() WHEN $4 IS TRUE THEN NULL ELSE archived_at END,
       updated_at = now()
     WHERE id = $1 RETURNING ${COLS}`,
    [
      id,
      input.name?.trim() || null,
      input.isGroupCapable ?? null,
      input.isActive ?? null,
      input.notes === undefined ? before.notes : input.notes?.trim() || null,
    ],
  );
  const after = toRecord(rows[0]!);
  await recordChange(pool, {
    actorId,
    action: "program_updated",
    entityType: "program",
    entityId: id,
    previous: before,
    next: after,
    reason,
  });
  return ok(after);
}

/**
 * Add a new effective-dated rate. Never edits an existing rate row — the rate
 * schedule is history, and the latest effective_from on or before a date wins.
 */
export async function addProgramRate(
  pool: PgLikePool,
  programId: string,
  input: { effectiveFrom: string; internalRate: string; agencyRate?: string | null; notes?: string | null },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  const program = await getProgram(pool, programId);
  if (!program) return fail("not_found", "That program no longer exists.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) {
    return fail("validation", "Give an effective-from date (YYYY-MM-DD).");
  }
  const internal = Number(input.internalRate);
  if (!Number.isFinite(internal) || internal < 0) {
    return fail("validation", "Enter a valid internal rate.");
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO program_rate_schedules
       (program_id, effective_from, agency_rate, internal_rate, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      programId,
      input.effectiveFrom,
      input.agencyRate ? toMoney(input.agencyRate) : null,
      toMoney(input.internalRate),
      input.notes?.trim() || null,
      actorId,
    ],
  );
  await recordChange(pool, {
    actorId,
    action: "program_rate_added",
    entityType: "program",
    entityId: programId,
    next: {
      effectiveFrom: input.effectiveFrom,
      internalRate: toMoney(input.internalRate),
      agencyRate: input.agencyRate ? toMoney(input.agencyRate) : null,
    },
    reason,
  });
  return ok({ id: rows[0]!.id });
}
