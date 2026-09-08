import { redirect } from "next/navigation";
import { apiUser, homePathForRole, requireUser, type AuthenticatedUser } from "./session";
import { resolveAccessScope, type AccessScope } from "./access";
import { withDb } from "@/lib/data/pool";
import { getPool } from "@/lib/db";
import type { PgLikePool } from "@/lib/import/commit";
import { resolvePortalAccess, type PortalAccessContext } from "./portal-access";

/**
 * Central decision points for document read and write capabilities. Pages and
 * future document APIs should call this instead of duplicating flag checks.
 */
export function canViewDocuments(
  scope: Pick<AccessScope, "canViewDocuments" | "canEditDocuments">,
): boolean {
  return scope.canViewDocuments;
}

export function canEditDocuments(scope: Pick<AccessScope, "canEditDocuments">): boolean {
  return scope.canEditDocuments;
}

export interface DocumentAccess {
  user: AuthenticatedUser;
  scope: AccessScope;
  pool: PgLikePool;
  portal?: PortalAccessContext;
  external?: boolean;
}
export type DocumentEditorAccess = DocumentAccess;

export function isExternalDocumentUser(scope: AccessScope, portal: PortalAccessContext): boolean {
  return scope.role !== "admin" && (portal.globalRoles.some((role) => role.role !== "owner") || portal.agencyAccess.length > 0);
}

async function apiDocumentUser(mode: "view" | "edit"): Promise<DocumentAccess | null> {
  const user = await apiUser("viewer");
  if (!user) return null;
  try {
    const pool = getPool() as unknown as PgLikePool;
    const scope = await resolveAccessScope(pool, user);
    return await resolveDocumentAccess(pool, user, scope, mode);
  } catch {
    return null;
  }
}

async function resolveDocumentAccess(pool: PgLikePool, user: AuthenticatedUser, scope: AccessScope, mode: "view" | "edit"): Promise<DocumentAccess | null> {
  const portal = await resolvePortalAccess(pool, user);
  const external = isExternalDocumentUser(scope, portal);
  if (!external && canViewDocuments(scope) && (mode === "view" || canEditDocuments(scope))) {
    return { user, scope, pool, portal, external };
  }
  if (mode === "edit") return null;
  // This only admits the request to resource authorization. It grants no document.
  const publications = await pool.query(`SELECT 1 FROM document_publications WHERE user_id = $1 LIMIT 1`, [user.id]);
  return publications.rows.length ? { user, scope, pool, portal, external: true } : null;
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
  const resolved = access.ok ? await resolveDocumentAccess(getPool() as unknown as PgLikePool, user, access.data, mode) : null;
  if (!resolved) {
    redirect(`${homePathForRole(user.role)}?denied=1`);
  }
  if (!access.ok) throw new Error("Document access could not be resolved.");
  return resolved;
}

export async function requireDocumentViewerUser(): Promise<DocumentAccess> {
  return requireDocumentUser("view");
}

export async function requireDocumentEditorUser(): Promise<DocumentEditorAccess> {
  return requireDocumentUser("edit");
}
