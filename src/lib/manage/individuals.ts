import type { PgLikePool } from "@/lib/import/commit";
import { normalizePersonName } from "@/lib/business/name-matching";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { individualScopeClause, type AccessScope } from "@/lib/auth/access";

/** Lifecycle states for a person. Nothing is ever hard-deleted. */
export const INDIVIDUAL_STATUSES = ["active", "inactive", "discharged", "archived"] as const;
export type IndividualStatus = (typeof INDIVIDUAL_STATUSES)[number];

export interface IndividualRecord {
  id: string;
  displayName: string;
  legalName: string | null;
  preferredName: string | null;
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
  legal_name: string | null;
  preferred_name: string | null;
  normalized_name: string;
  external_ref: string | null;
  status: string;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
}

const COLS = `id, display_name, legal_name, preferred_name, normalized_name,
              external_ref, status, notes, archived_at::text AS archived_at,
              created_at::text AS created_at`;

const toRecord = (r: Row): IndividualRecord => ({
  id: r.id,
  displayName: r.display_name,
  legalName: r.legal_name,
  preferredName: r.preferred_name,
  normalizedName: r.normalized_name,
  externalRef: r.external_ref,
  status: r.status,
  notes: r.notes,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
});

export async function getIndividual(pool: PgLikePool, id: string): Promise<IndividualRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM individuals WHERE id = $1`, [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface IndividualInput {
  displayName: string;
  legalName?: string | null;
  preferredName?: string | null;
  externalRef?: string | null;
  status?: string;
  notes?: string | null;
}

export async function createIndividual(
  pool: PgLikePool,
  input: IndividualInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<IndividualRecord>> {
  const displayName = input.displayName?.trim();
  if (!displayName) return fail("validation", "A name is required.");
  const normalized = normalizePersonName(displayName);
  if (!normalized) return fail("validation", "That name normalises to nothing usable.");

  const status = input.status && INDIVIDUAL_STATUSES.includes(input.status as IndividualStatus)
    ? input.status
    : "active";

  const existing = await pool.query(`SELECT id FROM individuals WHERE normalized_name = $1`, [
    normalized,
  ]);
  if (existing.rows[0]) {
    return fail("conflict", "An individual with this name already exists. Open that record instead.");
  }

  const { rows } = await pool.query<Row>(
    `INSERT INTO individuals
       (display_name, legal_name, preferred_name, normalized_name, external_ref, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLS}`,
    [
      displayName,
      input.legalName?.trim() || displayName,
      input.preferredName?.trim() || null,
      normalized,
      input.externalRef?.trim() || null,
      status,
      input.notes?.trim() || null,
    ],
  );
  const record = toRecord(rows[0]!);
  await recordChange(pool, {
    actorId,
    action: "individual_created",
    entityType: "individual",
    entityId: record.id,
    next: record,
    reason,
  });
  return ok(record);
}

export async function updateIndividual(
  pool: PgLikePool,
  id: string,
  input: IndividualInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<IndividualRecord>> {
  const before = await getIndividual(pool, id);
  if (!before) return fail("not_found", "That individual no longer exists.");

  const displayName = input.displayName?.trim() || before.displayName;
  const normalized = normalizePersonName(displayName);
  if (!normalized) return fail("validation", "That name normalises to nothing usable.");

  if (normalized !== before.normalizedName) {
    const clash = await pool.query(
      `SELECT id FROM individuals WHERE normalized_name = $1 AND id <> $2`,
      [normalized, id],
    );
    if (clash.rows[0]) {
      return fail("conflict", "Another individual already uses that name.");
    }
  }
  if (input.status && !INDIVIDUAL_STATUSES.includes(input.status as IndividualStatus)) {
    return fail("validation", "Unknown status.");
  }

  const { rows } = await pool.query<Row>(
    `UPDATE individuals SET
       display_name = $2,
       legal_name = $3,
       preferred_name = $4,
       normalized_name = $5,
       external_ref = $6,
       status = COALESCE($7, status),
       notes = $8,
       updated_at = now()
     WHERE id = $1
     RETURNING ${COLS}`,
    [
      id,
      displayName,
      input.legalName?.trim() || before.legalName || displayName,
      input.preferredName === undefined ? before.preferredName : input.preferredName?.trim() || null,
      normalized,
      input.externalRef === undefined ? before.externalRef : input.externalRef?.trim() || null,
      input.status ?? null,
      input.notes === undefined ? before.notes : input.notes?.trim() || null,
    ],
  );
  const after = toRecord(rows[0]!);
  await recordChange(pool, {
    actorId,
    action: "individual_updated",
    entityType: "individual",
    entityId: id,
    previous: before,
    next: after,
    reason,
  });
  return ok(after);
}

export async function setIndividualStatus(
  pool: PgLikePool,
  id: string,
  status: IndividualStatus,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<IndividualRecord>> {
  const before = await getIndividual(pool, id);
  if (!before) return fail("not_found", "That individual no longer exists.");
  if (!INDIVIDUAL_STATUSES.includes(status)) return fail("validation", "Unknown status.");

  const archivedAt = status === "archived" ? "now()" : "NULL";
  const { rows } = await pool.query<Row>(
    `UPDATE individuals SET status = $2, archived_at = ${archivedAt}, updated_at = now()
     WHERE id = $1 RETURNING ${COLS}`,
    [id, status],
  );
  const after = toRecord(rows[0]!);
  await recordChange(pool, {
    actorId,
    action: status === "archived" ? "individual_archived" : "individual_status_changed",
    entityType: "individual",
    entityId: id,
    previous: { status: before.status },
    next: { status },
    reason,
  });
  return ok(after);
}

export interface IndividualListFilter {
  status?: string;
  search?: string;
  includeArchived?: boolean;
  /** When present, restricts the list to the individuals this user may see. */
  scope?: AccessScope;
}

export async function listIndividualsManaged(
  pool: PgLikePool,
  filter: IndividualListFilter = {},
): Promise<IndividualRecord[]> {
  const status = INDIVIDUAL_STATUSES.includes(filter.status as IndividualStatus)
    ? filter.status!
    : null;
  const search = filter.search?.trim() ? `%${filter.search.trim()}%` : null;
  const params: unknown[] = [status, filter.includeArchived ?? false, search];
  const scopeClause = filter.scope ? individualScopeClause(filter.scope, "id", params) : "";
  const { rows } = await pool.query<Row>(
    `SELECT ${COLS} FROM individuals
     WHERE ($1::text IS NULL OR status = $1)
       AND ($2::boolean IS TRUE OR status <> 'archived')
       AND ($3::text IS NULL OR display_name ILIKE $3 OR legal_name ILIKE $3
            OR preferred_name ILIKE $3 OR external_ref ILIKE $3)${scopeClause}
     ORDER BY (status = 'archived'), display_name`,
    params,
  );
  return rows.map(toRecord);
}
