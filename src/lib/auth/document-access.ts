import { redirect } from "next/navigation";
import { apiUser, homePathForRole, requireUser, type AuthenticatedUser } from "./session";
import { resolveAccessScope, type AccessScope } from "./access";
import { withDb } from "@/lib/data/pool";
import { getPool } from "@/lib/db";
import type { PgLikePool } from "@/lib/import/commit";

/**
 * Central decision points for document read and write capabilities. Pages and
 * future document APIs should call this instead of duplicating flag checks.
 */
export function canViewDocuments(
  scope: Pick<AccessScope, "canViewDocuments" | "canEditDocuments">,
): boolean {
  return scope.canViewDocuments || scope.canEditDocuments;
}

export function canEditDocuments(scope: Pick<AccessScope, "canEditDocuments">): boolean {
  return scope.canEditDocuments;
}

export interface DocumentAccess {
  user: AuthenticatedUser;
  scope: AccessScope;
  pool: PgLikePool;
}
export type DocumentEditorAccess = DocumentAccess;

async function apiDocumentUser(mode: "view" | "edit"): Promise<DocumentAccess | null> {
  const user = await apiUser("viewer");
  if (!user) return null;
  try {
    const pool = getPool() as unknown as PgLikePool;
    const scope = await resolveAccessScope(pool, user);
    const allowed = mode === "edit" ? canEditDocuments(scope) : canViewDocuments(scope);
    return allowed ? { user, scope, pool } : null;
  } catch {
    return null;
  }
}

/** Resolve read access at an API boundary. Document IDs are checked later. */
export async function apiDocumentViewerUser(): Promise<DocumentAccess | null> {
  return apiDocumentUser("view");
}

/** Resolve document access at an API boundary. Document IDs are checked later. */
export async function apiDocumentEditorUser(): Promise<DocumentEditorAccess | null> {
  return apiDocumentUser("edit");
}

async function requireDocumentUser(mode: "view" | "edit"): Promise<DocumentAccess> {
  const user = await requireUser("viewer");
  const access = await withDb((pool) => resolveAccessScope(pool, user));
  const allowed = access.ok && (mode === "edit"
    ? canEditDocuments(access.data)
    : canViewDocuments(access.data));
  if (!access.ok || !allowed) {
    redirect(`${homePathForRole(user.role)}?denied=1`);
  }
  if (!access.ok) throw new Error("Document access could not be resolved.");
  return { user, scope: access.data, pool: getPool() as unknown as PgLikePool };
}

export async function requireDocumentViewerUser(): Promise<DocumentAccess> {
  return requireDocumentUser("view");
}

export async function requireDocumentEditorUser(): Promise<DocumentEditorAccess> {
  return requireDocumentUser("edit");
}
