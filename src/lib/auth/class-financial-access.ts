import {
  hasDirectIndividualAccess,
  resolveAccessScope,
  type AccessScope,
} from "@/lib/auth/access";
import { apiUser, type AuthenticatedUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import type { PgLikePool } from "@/lib/import/commit";

export interface ClassFinancialAccess {
  user: AuthenticatedUser;
  scope: AccessScope;
  pool: PgLikePool;
}

/**
 * Resolve the class-revenue permission at the server boundary. This is never
 * inferred from Planning access: class budgets, invoice totals, and documents
 * are financial records and require their own explicit grant.
 */
export async function apiClassFinancialUser(
  mode: "view" | "manage" = "view",
): Promise<ClassFinancialAccess | null> {
  const user = await apiUser("viewer");
  if (!user) return null;

  try {
    const pool = getPool() as unknown as PgLikePool;
    const scope = await resolveAccessScope(pool, user);
    if (!scope.canSeeClassFinancials) return null;
    if (mode === "manage" && !scope.canManageClassInvoices) return null;
    return { user, scope, pool };
  } catch {
    return null;
  }
}

/** Class financial data requires a direct individual grant, not roster expansion. */
export function canAccessClassIndividual(scope: AccessScope, individualId: string): boolean {
  return hasDirectIndividualAccess(scope, individualId);
}
