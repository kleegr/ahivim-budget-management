import { redirect } from "next/navigation";
import { apiUser, homePathForRole, requireUser, type AuthenticatedUser } from "./session";
import { resolveAccessScope, type AccessScope } from "./access";
import { withDb } from "@/lib/data/pool";
import { getPool } from "@/lib/db";
import type { PgLikePool } from "@/lib/import/commit";

/**
 * Central decision point for the `can_edit_documents` capability. Pages and
 * future document APIs should call this instead of duplicating flag checks.
 */
export function canEditDocuments(scope: Pick<AccessScope, "canEditDocuments">): boolean {
  return scope.canEditDocuments;
}

export interface DocumentEditorAccess {
  user: AuthenticatedUser;
  scope: AccessScope;
  pool: PgLikePool;
}

/** Resolve document access at an API boundary. Document IDs are checked later. */
export async function apiDocumentEditorUser(): Promise<DocumentEditorAccess | null> {
  const user = await apiUser("viewer");
  if (!user) return null;
  try {
    const pool = getPool() as unknown as PgLikePool;
    const scope = await resolveAccessScope(pool, user);
    return canEditDocuments(scope) ? { user, scope, pool } : null;
  } catch {
    return null;
  }
}

export async function requireDocumentEditorUser(): Promise<AuthenticatedUser> {
  const user = await requireUser("viewer");
  const access = await withDb((pool) => resolveAccessScope(pool, user));
  if (!access.ok || !canEditDocuments(access.data)) {
    redirect(`${homePathForRole(user.role)}?denied=1`);
  }
  return user;
}
