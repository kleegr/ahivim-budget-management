import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { canAccessPlanning, resolveAccessScope, type AccessScope } from "./access";
import {
  apiUser,
  homePathForRole,
  requireUser,
  type AuthenticatedUser,
} from "./session";

export interface PlanningAccess {
  user: AuthenticatedUser;
  access: AccessScope;
}

/**
 * Resolve API access for Planning without granting the broader manager role.
 * Database failures fail closed so schedule endpoints never fall back to role-
 * only access for a restricted account.
 */
export async function apiPlanningUser(): Promise<PlanningAccess | null> {
  const user = await apiUser("viewer");
  if (!user) return null;

  try {
    const access = await resolveAccessScope(getPool(), user);
    return canAccessPlanning(access) ? { user, access } : null;
  } catch {
    return null;
  }
}

/** Page equivalent of apiPlanningUser: signed-out users go to sign-in. */
export async function requirePlanningUser(): Promise<PlanningAccess> {
  const user = await requireUser("viewer");
  const access = await resolveAccessScope(getPool(), user);
  if (!canAccessPlanning(access)) redirect(`${homePathForRole(user.role)}?denied=1`);
  return { user, access };
}
