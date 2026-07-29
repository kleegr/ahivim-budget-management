import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { normalizePersonName, matchPerson, type CanonicalRecord, type AliasRecord } from "@/lib/business/name-matching";

/**
 * Alias management: an imported spelling mapped to a canonical person. Only
 * APPROVED aliases resolve future imports; nothing merges people automatically.
 */

export type AliasKind = "individual" | "employee";
const TABLE: Record<AliasKind, string> = {
  individual: "individual_aliases",
  employee: "employee_aliases",
};
const FK: Record<AliasKind, string> = {
  individual: "individual_id",
  employee: "employee_id",
};
const PEOPLE: Record<AliasKind, string> = { individual: "individuals", employee: "employees" };
const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

export interface AliasManagementRow {
  id: string;
  kind: AliasKind;
  importedName: string;
  normalizedAlias: string;
  canonicalId: string;
  canonicalName: string;
  status: string;
  createdBy: string | null;
  approvedBy: string | null;
  firstSeen: string;
  lastUsed: string | null;
  rowsAffected: number;
}

export async function listAliases(
  pool: PgLikePool,
  filter: { kind?: AliasKind; status?: string; search?: string } = {},
): Promise<AliasManagementRow[]> {
  const kinds: AliasKind[] = filter.kind ? [filter.kind] : ["individual", "employee"];
  const status = ["pending", "approved", "rejected", "archived"].includes(filter.status ?? "")
    ? filter.status!
    : null;
  const search = filter.search?.trim() ? `%${filter.search.trim()}%` : null;

  const all: AliasManagementRow[] = [];
  for (const kind of kinds) {
    const { rows } = await pool.query<{
      id: string; source_text: string; normalized_alias: string; canonical_id: string;
      canonical_name: string; status: string; created_by: string | null; approved_by: string | null;
      first_seen: string; last_used: string | null; rows_affected: number;
    }>(
      `SELECT a.id, a.source_text, a.normalized_alias, a.${FK[kind]} AS canonical_id,
              c.display_name AS canonical_name, a.status,
              cu.display_name AS created_by, au.display_name AS approved_by,
              a.created_at::text AS first_seen, a.last_used_at::text AS last_used,
              a.rows_affected
       FROM ${TABLE[kind]} a
       JOIN ${PEOPLE[kind]} c ON c.id = a.${FK[kind]}
       LEFT JOIN users cu ON cu.id = a.created_by_user_id
       LEFT JOIN users au ON au.id = a.approved_by_user_id
       WHERE ($1::text IS NULL OR a.status = $1)
         AND ($2::text IS NULL OR a.source_text ILIKE $2 OR c.display_name ILIKE $2)
       ORDER BY (a.status = 'pending') DESC, a.created_at DESC`,
      [status, search],
    );
    for (const r of rows) {
      all.push({
        id: r.id,
        kind,
        importedName: r.source_text,
        normalizedAlias: r.normalized_alias,
        canonicalId: r.canonical_id,
        canonicalName: r.canonical_name,
        status: r.status,
        createdBy: r.created_by,
        approvedBy: r.approved_by,
        firstSeen: r.first_seen,
        lastUsed: r.last_used,
        rowsAffected: Number(r.rows_affected ?? 0),
      });
    }
  }
  return all;
}

async function getAliasRaw(pool: PgLikePool, kind: AliasKind, id: string) {
  const { rows } = await pool.query<{ id: string; source_text: string; normalized_alias: string; status: string; canonical_id: string }>(
    `SELECT id, source_text, normalized_alias, status, ${FK[kind]} AS canonical_id
     FROM ${TABLE[kind]} WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createAlias(
  pool: PgLikePool,
  kind: AliasKind,
  input: { importedName: string; canonicalId: string; approve?: boolean },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  const sourceText = input.importedName?.trim();
  if (!sourceText) return fail("validation", "Enter the imported spelling.");
  if (!isUuid(input.canonicalId)) return fail("validation", "Choose the canonical record.");
  const normalized = normalizePersonName(sourceText);
  if (!normalized) return fail("validation", "That spelling normalises to nothing usable.");

  const person = await pool.query(`SELECT id FROM ${PEOPLE[kind]} WHERE id = $1`, [input.canonicalId]);
  if (!person.rows[0]) return fail("not_found", "That canonical record no longer exists.");

  const clash = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM ${TABLE[kind]} WHERE normalized_alias = $1`,
    [normalized],
  );
  if (clash.rows[0]) {
    return fail("conflict", `That spelling is already an alias (${clash.rows[0].status}). Rematch it instead.`);
  }

  const status = input.approve ? "approved" : "pending";
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ${TABLE[kind]}
       (${FK[kind]}, normalized_alias, source_text, status, created_by_user_id, approved_by_user_id, approved_at)
     VALUES ($1, $2, $3, $4, $5, ${input.approve ? "$5" : "NULL"}, ${input.approve ? "now()" : "NULL"})
     RETURNING id`,
    [input.canonicalId, normalized, sourceText, status, actorId],
  );
  await recordChange(pool, {
    actorId,
    action: input.approve ? "alias_created_approved" : "alias_created",
    entityType: `${kind}_alias`,
    entityId: rows[0]!.id,
    next: { importedName: sourceText, canonicalId: input.canonicalId, status },
    reason,
  });
  return ok({ id: rows[0]!.id });
}

export async function setAliasStatus(
  pool: PgLikePool,
  kind: AliasKind,
  id: string,
  status: "approved" | "rejected" | "archived" | "pending",
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  const before = await getAliasRaw(pool, kind, id);
  if (!before) return fail("not_found", "That alias no longer exists.");
  // $3 (actorId) is always referenced so the bind count is constant regardless
  // of the target status; only the approved path retains it.
  const archivedAt = status === "archived" ? "now()" : "NULL";
  await pool.query(
    `UPDATE ${TABLE[kind]} SET
       status = $2,
       approved_by_user_id = CASE WHEN $2 = 'approved' THEN $3::uuid ELSE NULL END,
       approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE NULL END,
       archived_at = ${archivedAt},
       updated_at = now()
     WHERE id = $1`,
    [id, status, actorId],
  );
  await recordChange(pool, {
    actorId,
    action: `alias_${status}`,
    entityType: `${kind}_alias`,
    entityId: id,
    previous: { status: before.status },
    next: { status },
    reason,
  });
  return ok({ id });
}

/** Point an existing alias at a different canonical record. */
export async function rematchAlias(
  pool: PgLikePool,
  kind: AliasKind,
  id: string,
  newCanonicalId: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  const before = await getAliasRaw(pool, kind, id);
  if (!before) return fail("not_found", "That alias no longer exists.");
  if (!isUuid(newCanonicalId)) return fail("validation", "Choose the new canonical record.");
  const person = await pool.query(`SELECT id FROM ${PEOPLE[kind]} WHERE id = $1`, [newCanonicalId]);
  if (!person.rows[0]) return fail("not_found", "That canonical record no longer exists.");

  await pool.query(`UPDATE ${TABLE[kind]} SET ${FK[kind]} = $2, updated_at = now() WHERE id = $1`, [
    id,
    newCanonicalId,
  ]);
  await recordChange(pool, {
    actorId,
    action: "alias_rematched",
    entityType: `${kind}_alias`,
    entityId: id,
    previous: { canonicalId: before.canonical_id },
    next: { canonicalId: newCanonicalId },
    reason,
  });
  return ok({ id });
}

/** Suggestions for an imported name, with the reason each was proposed. */
export async function suggestMatches(
  pool: PgLikePool,
  kind: AliasKind,
  importedName: string,
): Promise<{ suggestions: { id: string; displayName: string; similarity: number }[]; reason: string; exact: boolean }> {
  const { rows: people } = await pool.query<{ id: string; normalized_name: string; display_name: string }>(
    `SELECT id, normalized_name, display_name FROM ${PEOPLE[kind]} WHERE status <> 'archived'`,
  );
  const canonical: CanonicalRecord[] = people.map((p) => ({
    id: p.id,
    normalizedName: p.normalized_name,
    displayName: p.display_name,
  }));
  const { rows: aliasRows } = await pool.query<{ normalized_alias: string; canonical_id: string; status: string }>(
    `SELECT normalized_alias, ${FK[kind]} AS canonical_id, status FROM ${TABLE[kind]} WHERE status = 'approved'`,
  );
  const aliases: AliasRecord[] = aliasRows.map((a) => ({
    normalizedAlias: a.normalized_alias,
    targetId: a.canonical_id,
    status: "approved",
  }));

  const result = matchPerson(importedName, canonical, aliases);
  return {
    suggestions: result.suggestions,
    reason: result.reason,
    exact: result.outcome === "exact" || result.outcome === "alias",
  };
}
