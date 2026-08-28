import type { PgLikePool } from "@/lib/import/commit";
import { ok, fail, type Result } from "@/lib/manage/errors";
import { recordChange } from "@/lib/manage/audit";
import { similarity } from "@/lib/business/name-matching";
import { repointSettlementPerson } from "@/lib/manage/settlement-person-merge";
import { acquireSettlementSourceLock } from "@/lib/manage/settlement-freshness";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Merge one employee into another (the twin of mergeIndividuals). Every child
 * row that references the folded-in employee is repointed to the survivor, the
 * old spelling is recorded as an approved employee alias (so future imports
 * resolve to the survivor), and the folded-in row is archived — never deleted,
 * so the change is auditable. Employees have no merged_into pointer column, so
 * the archive + alias + audit entry are what mark the fold-in.
 */
export async function mergeEmployees(
  pool: PgLikePool,
  input: { keepId: string; mergeId: string },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ keepId: string; mergeId: string; repointed: Record<string, number> }>> {
  const { keepId, mergeId } = input;
  if (!UUID.test(keepId) || !UUID.test(mergeId)) return fail("validation", "Valid employees are required.");
  if (keepId === mergeId) return fail("validation", "Cannot merge an employee into itself.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await acquireSettlementSourceLock(client);
    const both = await client.query<{ id: string; display_name: string; normalized_name: string; status: string }>(
      `SELECT id, display_name, normalized_name, status FROM employees WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [[keepId, mergeId]],
    );
    const keep = both.rows.find((r) => r.id === keepId);
    const merge = both.rows.find((r) => r.id === mergeId);
    if (!keep || !merge) {
      await client.query("ROLLBACK");
      return fail("not_found", "One of the employees no longer exists.");
    }
    if (merge.status === "archived") {
      await client.query("ROLLBACK");
      return fail("conflict", "That employee is already archived.");
    }

    const dealOwners = await client.query<{ employee_id: string }>(
      `SELECT employee_id
         FROM employee_deals
        WHERE employee_id = ANY($1::uuid[])
        ORDER BY id
        FOR UPDATE`,
      [[keepId, mergeId]],
    );
    const keepDealCount = dealOwners.rows.filter((row) => row.employee_id === keepId).length;
    const mergeDealCount = dealOwners.rows.filter((row) => row.employee_id === mergeId).length;
    if (keepDealCount > 0 && mergeDealCount > 0) {
      await client.query("ROLLBACK");
      return fail(
        "conflict",
        "Both employees have deal history. Resolve which deal history should remain before merging them.",
      );
    }

    // Repoint every table with an employee_id column (robust to schema growth).
    const cols = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'employee_id'`,
    );
    const repointed: Record<string, number> = await repointSettlementPerson(client, "employee", keepId, mergeId);
    const movedLegacyAccess = await client.query(
      `INSERT INTO user_employee_access (user_id, employee_id, created_at)
       SELECT user_id, $1, created_at
         FROM user_employee_access
        WHERE employee_id = $2
       ON CONFLICT (user_id, employee_id) DO NOTHING`,
      [keepId, mergeId],
    );
    await client.query(`DELETE FROM user_employee_access WHERE employee_id = $1`, [mergeId]);
    if (movedLegacyAccess.rowCount) repointed.user_employee_access = movedLegacyAccess.rowCount;

    const movedPortalRelationships = await client.query(
      `INSERT INTO user_employee_relationships
         (user_id, employee_id, relationship_type, is_active, capability_grants,
          capability_denials, created_by_user_id, updated_by_user_id, created_at, updated_at)
       SELECT user_id, $1, relationship_type, is_active, capability_grants,
              capability_denials, created_by_user_id, $3, created_at, now()
         FROM user_employee_relationships
        WHERE employee_id = $2
       ON CONFLICT (user_id, employee_id, relationship_type) DO UPDATE SET
         is_active = user_employee_relationships.is_active OR EXCLUDED.is_active,
         capability_grants = ARRAY(
           SELECT DISTINCT capability
             FROM unnest(user_employee_relationships.capability_grants || EXCLUDED.capability_grants) capability
            ORDER BY capability
         ),
         capability_denials = ARRAY(
           SELECT DISTINCT capability
             FROM unnest(user_employee_relationships.capability_denials || EXCLUDED.capability_denials) capability
            ORDER BY capability
         ),
         updated_by_user_id = $3,
         updated_at = now()`,
      [keepId, mergeId, actorId],
    );
    await client.query(`DELETE FROM user_employee_relationships WHERE employee_id = $1`, [mergeId]);
    if (movedPortalRelationships.rowCount) {
      repointed.user_employee_relationships = movedPortalRelationships.rowCount;
    }

    await client.query(
      `SELECT pg_advisory_xact_lock(lock_key)
         FROM (
           SELECT DISTINCT hashtextextended(
                    'agency_employees:' || agency_id::text || ':' || person_id::text,
                    0
                  ) AS lock_key
             FROM agency_employees
             CROSS JOIN LATERAL unnest($1::uuid[]) AS people(person_id)
            WHERE employee_id = ANY($1::uuid[])
            ORDER BY lock_key
         ) timeline_locks`,
      [[keepId, mergeId]],
    );
    const overlappingAgencyMemberships = await client.query<{ id: string }>(
      `SELECT source.id
         FROM agency_employees source
         JOIN agency_employees target
           ON target.agency_id = source.agency_id
          AND target.employee_id = $1
          AND target.is_active = true
          AND daterange(target.effective_from, target.effective_to, '[]')
              && daterange(source.effective_from, source.effective_to, '[]')
        WHERE source.employee_id = $2
          AND source.is_active = true
        LIMIT 1`,
      [keepId, mergeId],
    );
    if (overlappingAgencyMemberships.rows[0]) {
      await client.query("ROLLBACK");
      return fail(
        "conflict",
        "Resolve overlapping agency membership history before merging these employees.",
      );
    }
    const movedAgencyMemberships = await client.query(
      `UPDATE agency_employees
          SET employee_id = $1, updated_by_user_id = $3, updated_at = now()
        WHERE employee_id = $2`,
      [keepId, mergeId, actorId],
    );
    if (movedAgencyMemberships.rowCount) repointed.agency_employees = movedAgencyMemberships.rowCount;
    if (mergeDealCount > 0) {
      const deals = await client.query(
        `UPDATE employee_deals SET employee_id = $1, updated_at = now() WHERE employee_id = $2`,
        [keepId, mergeId],
      );
      if (deals.rowCount) repointed.employee_deals = deals.rowCount;
    }
    for (const { table_name } of cols.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table_name)) continue;
      if ([
        "employee_deals",
        "settlement_events",
        "settlement_obligations",
        "user_employee_access",
        "user_employee_relationships",
        "agency_employees",
      ].includes(table_name)) continue;
      const res = await client.query(
        `UPDATE "${table_name}" SET employee_id = $1 WHERE employee_id = $2`,
        [keepId, mergeId],
      );
      if (res.rowCount) repointed[table_name] = res.rowCount;
    }

    // Record the old spelling as an approved alias → future imports resolve to the survivor.
    await client.query(
      `INSERT INTO employee_aliases (employee_id, normalized_alias, source_text, status, approved_by_user_id, approved_at)
       VALUES ($1, $2, $3, 'approved', $4, now())
       ON CONFLICT (normalized_alias) DO UPDATE
         SET employee_id = EXCLUDED.employee_id, status = 'approved', approved_by_user_id = EXCLUDED.approved_by_user_id, approved_at = now()`,
      [keepId, merge.normalized_name, merge.display_name, actorId],
    );

    // Archive the folded-in row.
    await client.query(
      `UPDATE employees SET status = 'archived', archived_at = now(), updated_at = now() WHERE id = $1`,
      [mergeId],
    );

    await recordChange(client, {
      actorId,
      action: "employees_merged",
      entityType: "employee",
      entityId: keepId,
      reason: reason ?? null,
      extra: { mergedId: mergeId, mergedName: merge.display_name, repointed },
    });

    await client.query("COMMIT");
    return ok({ keepId, mergeId, repointed });
  } catch (error) {
    await client.query("ROLLBACK");
    return fail("validation", error instanceof Error ? error.message : "Merge failed.");
  } finally {
    client.release();
  }
}

export interface EmployeeMergeCandidate {
  id: string;
  name: string;
  txCount: number;
  similarity: number; // 0..1 name similarity to the target
}

/**
 * Other employee records that could be the SAME worker as `employeeId` — a
 * spelling variant that minted a separate row on import. Ranked by name
 * similarity, then by how many transactions they carry. A free-text `q` narrows
 * by name so an operator can find a spelling the score wouldn't surface.
 */
export async function listEmployeeMergeCandidates(
  pool: PgLikePool,
  employeeId: string,
  q?: string | null,
): Promise<EmployeeMergeCandidate[]> {
  if (!UUID.test(employeeId)) return [];
  const target = await pool.query<{ normalized_name: string }>(
    `SELECT normalized_name FROM employees WHERE id = $1`,
    [employeeId],
  );
  const targetName = target.rows[0]?.normalized_name ?? "";
  const search = q && q.trim() ? `%${q.trim()}%` : null;

  const { rows } = await pool.query<{ id: string; name: string; normalized_name: string; tx_count: number }>(
    `SELECT e.id,
            COALESCE(e.display_name, e.normalized_name) AS name,
            e.normalized_name,
            (SELECT count(*) FROM payroll_transactions t WHERE t.employee_id = e.id)::int AS tx_count
       FROM employees e
      WHERE e.id <> $1
        AND e.status <> 'archived'
        AND ($2::text IS NULL OR e.display_name ILIKE $2 OR e.normalized_name ILIKE $2)
      ORDER BY tx_count DESC
      LIMIT 100`,
    [employeeId, search],
  );

  const scored = rows.map((r) => ({
    id: r.id,
    name: r.name,
    txCount: r.tx_count,
    similarity: targetName ? similarity(targetName, r.normalized_name) : 0,
  }));
  scored.sort((a, b) => (search ? b.txCount - a.txCount : b.similarity - a.similarity || b.txCount - a.txCount));
  return scored.slice(0, 25);
}
