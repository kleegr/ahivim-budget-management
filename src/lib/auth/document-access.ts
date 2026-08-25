import { redirect } from "next/navigation";
import { homePathForRole, requireUser, type AuthenticatedUser } from "./session";
import { resolveAccessScope, type AccessScope } from "./access";
import { withDb } from "@/lib/data/pool";

/**
 * Central decision point for the `can_edit_documents` capability. Pages and
 * future document APIs should call this instead of duplicating flag checks.
 */
export function canEditDocuments(scope: Pick<AccessScope, "canEditDocuments">): boolean {
  return scope.canEditDocuments;
}

export async function requireDocumentEditorUser(): Promise<AuthenticatedUser> {
  const user = await requireUser("viewer");
  const access = await withDb((pool) => resolveAccessScope(pool, user));
  if (!access.ok || !canEditDocuments(access.data)) {
    redirect(`${homePathForRole(user.role)}?denied=1`);
  }
  return user;
}
