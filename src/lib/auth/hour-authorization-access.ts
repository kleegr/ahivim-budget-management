import {
  canAccessPlanning,
  hasDirectIndividualAccess,
  resolveAccessScope,
  type AccessScope,
} from "@/lib/auth/access";
import { apiUser, type AuthenticatedUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import type { PgLikePool } from "@/lib/import/commit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HourAuthorizationOperator {
  user: AuthenticatedUser;
  scope: AccessScope;
  pool: PgLikePool;
  mode: "full" | "hours_only";
}

/**
 * Internal budget planners may maintain authorization hours, but this does not
 * grant any financial workspace or field. Agency portal schedulers remain
 * excluded because their internal access scope is portal-only.
 */
export function canManageHourAuthorizations(
  scope: Pick<
    AccessScope,
    "canPlan" | "canSeeHours" | "canSeeBudgets" | "full" | "allIndividuals" | "allEmployees"
  >,
): boolean {
  return scope.canSeeHours && scope.canSeeBudgets && canAccessPlanning(scope);
}

/** Resolve a manager/admin, or the narrow internal hours-only planner. */
export async function getHourAuthorizationOperator(): Promise<HourAuthorizationOperator | null> {
  const user = await apiUser("viewer");
  if (!user) return null;
  const pool = getPool() as unknown as PgLikePool;
  try {
    const scope = await resolveAccessScope(pool, user);
    if (user.role !== "viewer") return { user, scope, pool, mode: "full" };
    if (!canManageHourAuthorizations(scope)) return null;
    return { user, scope, pool, mode: "hours_only" };
  } catch {
    return null;
  }
}

export function containsFinancialAuthorizationFields(input: Record<string, unknown>): boolean {
  return [
    "authorizedDollars",
    "internalRate",
    "agencyRate",
    "individualRateOverride",
  ].some((field) => Object.prototype.hasOwnProperty.call(input, field));
}

export async function canCreateHourProgramBudget(
  pool: PgLikePool,
  scope: AccessScope,
  individualId: string,
  programId: string,
): Promise<boolean> {
  if (!UUID.test(individualId) || !UUID.test(programId)) return false;
  if (!hasDirectIndividualAccess(scope, individualId)) return false;
  const { rows } = await pool.query<{ allowed: boolean }>(
    `SELECT true AS allowed
       FROM programs
      WHERE id = $1
        AND is_active = true
        AND code <> 'CLASSES'
        AND required_auth_type = 'hours'
      LIMIT 1`,
    [programId],
  );
  return rows[0]?.allowed === true;
}

export async function canCreateHourAuthorization(
  pool: PgLikePool,
  scope: AccessScope,
  budgetPeriodId: string,
  programId: string,
): Promise<boolean> {
  if (!UUID.test(budgetPeriodId) || !UUID.test(programId)) return false;
  const { rows } = await pool.query<{ individual_id: string }>(
    `SELECT period.individual_id
       FROM budget_periods period
       JOIN programs program ON program.id = $2
      WHERE period.id = $1
        AND period.status = 'active'
        AND program.is_active = true
        AND program.code <> 'CLASSES'
        AND program.required_auth_type = 'hours'
      LIMIT 1`,
    [budgetPeriodId, programId],
  );
  return Boolean(
    rows[0]
    && hasDirectIndividualAccess(scope, rows[0].individual_id),
  );
}

export async function canChangeHourAuthorization(
  pool: PgLikePool,
  scope: AccessScope,
  authorizationId: string,
): Promise<boolean> {
  if (!UUID.test(authorizationId)) return false;
  const { rows } = await pool.query<{ individual_id: string }>(
    `SELECT budget_auth.individual_id
       FROM budget_authorizations budget_auth
       JOIN programs program ON program.id = budget_auth.program_id
      WHERE budget_auth.id = $1
        AND program.code <> 'CLASSES'
        AND program.required_auth_type = 'hours'
      LIMIT 1`,
    [authorizationId],
  );
  return Boolean(
    rows[0]
    && hasDirectIndividualAccess(scope, rows[0].individual_id),
  );
}

/** A planner may change a period renewal only when every active line is hours-only. */
export async function canChangeHourBudgetPeriod(
  pool: PgLikePool,
  scope: AccessScope,
  budgetPeriodId: string,
): Promise<boolean> {
  if (!UUID.test(budgetPeriodId)) return false;
  const { rows } = await pool.query<{ individual_id: string; allowed: boolean }>(
    `SELECT period.individual_id,
            count(budget_auth.id) > 0
            AND bool_and(program.code <> 'CLASSES' AND program.required_auth_type = 'hours') AS allowed
       FROM budget_periods period
       JOIN budget_authorizations budget_auth
         ON budget_auth.budget_period_id = period.id
        AND budget_auth.status = 'active'
        AND budget_auth.archived_at IS NULL
       JOIN programs program ON program.id = budget_auth.program_id
      WHERE period.id = $1
        AND period.status = 'active'
        AND period.archived_at IS NULL
      GROUP BY period.individual_id`,
    [budgetPeriodId],
  );
  return Boolean(
    rows[0]?.allowed
    && hasDirectIndividualAccess(scope, rows[0].individual_id),
  );
}

/** Remove every amount/rate field from a planner mutation response. */
export function redactHourAuthorizationResult<T extends object>(data: T): T {
  return {
    ...data,
    authorizedDollars: null,
    consumedDollars: null,
    remainingDollars: null,
    internalRate: null,
    agencyRate: null,
    individualRateOverride: null,
  } as unknown as T;
}
