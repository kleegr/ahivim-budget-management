import type { EmployeeIdentityDirectory } from "@/lib/business/employee-identity";
import type { PgLikePool } from "@/lib/import/commit";

/** One statement keeps canonical names, approved aliases, and merge lineage in the same snapshot. */
export async function loadEmployeeIdentityDirectory(pool: Pick<PgLikePool, "query">): Promise<EmployeeIdentityDirectory> {
  const { rows } = await pool.query<EmployeeIdentityDirectory>(`SELECT
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'normalizedName', normalized_name,
      'displayName', display_name, 'status', status)), '[]'::jsonb) FROM employees) AS employees,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('normalizedAlias', normalized_alias,
      'targetId', employee_id, 'status', status)), '[]'::jsonb) FROM employee_aliases) AS aliases,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('mergedId', metadata->>'mergedId',
      'survivorId', entity_id, 'mergedName', metadata->>'mergedName')), '[]'::jsonb)
      FROM audit_logs WHERE action = 'employees_merged' AND entity_type = 'employee') AS merges`);
  if (!rows[0]) throw new Error("Employee identity evidence is unavailable. Refresh the import review.");
  return rows[0];
}
