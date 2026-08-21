import type { PgLikePool } from "@/lib/import/commit";
import { ok, fail, type Result } from "@/lib/manage/errors";
import { recordChange } from "@/lib/manage/audit";
import { similarity } from "@/lib/business/name-matching";

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

    // Repoint every table with an employee_id column (robust to schema growth).
    const cols = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'employee_id'`,
    );
    const repointed: Record<string, number> = {};
    for (const { table_name } of cols.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table_name)) continue;
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
