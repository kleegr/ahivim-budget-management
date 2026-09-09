import type { PgLikePool } from "@/lib/import/commit";
import { canAccessPlanning, canViewIndividual, employeeScopeClause, transactionScopeClause, type AccessScope } from "@/lib/auth/access";
export interface PriorWorker { employeeId: string; employeeName: string; programId: string; programName: string; lastServiceDate: string | null; canCreateAssignment?: boolean }
/** Staffing relationship context only. No pay, check identities or financial rows. */
export async function listPriorWorkers(pool: PgLikePool, scope: AccessScope, individualId: string): Promise<PriorWorker[]> {
  if (!canAccessPlanning(scope) || !canViewIndividual(scope, individualId)) return [];
  const params: unknown[] = [individualId];
  const employees = employeeScopeClause(scope, "employee.id", params);
  const transactions = transactionScopeClause(scope, "activity.individual_id", "activity.employee_id", params);
  const result = await pool.query<{ employee_id: string; employee_name: string; program_id: string; program_name: string; last_service_date: string | null; can_create_assignment: boolean }>(
    `SELECT employee.id AS employee_id, employee.display_name AS employee_name, program.id AS program_id,
      program.name AS program_name, max(canonical_service_date(activity.period_begin, activity.check_date, activity.period_end))::text AS last_service_date,
      (employee.status = 'active' AND employee.archived_at IS NULL AND program.is_active AND program.archived_at IS NULL) AS can_create_assignment
     FROM payroll_transactions activity JOIN employees employee ON employee.id = activity.employee_id
     JOIN programs program ON program.id = activity.program_id
     WHERE activity.individual_id = $1 ${employees}${transactions}
     GROUP BY employee.id, employee.display_name, program.id, program.name
     ORDER BY last_service_date DESC NULLS LAST, employee.display_name, employee.id, program.id`, params);
  return result.rows.map((row) => ({ employeeId: row.employee_id, employeeName: row.employee_name, programId: row.program_id, programName: row.program_name, lastServiceDate: row.last_service_date, canCreateAssignment: row.can_create_assignment }));
}
