import { getPool } from "@/lib/db";
import { apiUser, type AuthenticatedUser } from "./session";
import {
  hasPortalCapability,
  resolvePortalAccess,
  type PortalAccessContext,
  type PortalCapability,
} from "./portal-access";

export interface AuthorizedPortalUser {
  user: AuthenticatedUser;
  access: PortalAccessContext;
  pool: ReturnType<typeof getPool>;
}

/** Resolve the new portal authorization context without consulting legacy grants. */
export async function apiPortalUser(
  capability?: PortalCapability,
  agencyId?: string,
): Promise<AuthorizedPortalUser | null> {
  const user = await apiUser("viewer");
  if (!user) return null;
  const pool = getPool();
  const access = await resolvePortalAccess(pool, user);
  if (capability && !hasPortalCapability(access, capability, agencyId)) return null;
  return { user, access, pool };
}
