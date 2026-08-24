import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signSession, readSession, type SessionPayload } from "./crypto";

/**
 * Session cookie: HttpOnly, Secure in production, SameSite=Lax, 12h expiry.
 * Roles: 'admin' | 'manager' | 'viewer'.
 *
 *   viewer   restricted access configured by an administrator
 *   manager  viewer + upload, commit/discard imports, resolve warnings
 *   admin    manager + user management, rate configuration, migrations
 *
 * The signed cookie is only the first half of the check. Everything that
 * matters re-reads the user from the database (see requireUser / apiUser), so
 * a deactivated account or a demoted role takes effect on the next request
 * instead of at the end of the cookie's 12 hours.
 */

export const SESSION_COOKIE = "ahivim_session";
export const SESSION_HOURS = 12;

export type Role = "admin" | "manager" | "viewer";

const RANK: Record<Role, number> = { viewer: 0, manager: 1, admin: 2 };

export function roleAtLeast(actual: string | undefined, required: Role): boolean {
  if (!actual || !(actual in RANK)) return false;
  return RANK[actual as Role] >= RANK[required];
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  manager: "Manager",
  viewer: "Viewer",
};

export async function createSessionCookie(user: {
  id: string;
  role: string;
  displayName: string;
}): Promise<void> {
  const payload: SessionPayload = {
    userId: user.id,
    role: user.role,
    displayName: user.displayName,
    exp: Date.now() + SESSION_HOURS * 60 * 60 * 1000,
  };
  const store = await cookies();
  store.set(SESSION_COOKIE, signSession(payload), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_HOURS * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function currentSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return readSession(store.get(SESSION_COOKIE)?.value);
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

/**
 * Authoritative check. Verifies the cookie signature and expiry, then confirms
 * the account still exists, is still active, and still holds the role the
 * cookie claims. Returns null rather than throwing so callers choose their own
 * failure mode (redirect for pages, status code for APIs).
 */
export async function currentUser(): Promise<AuthenticatedUser | null> {
  const session = await currentSession();
  if (!session) return null;

  const { getPool } = await import("@/lib/db");
  const { findUserById } = await import("./users");

  let record;
  try {
    record = await findUserById(getPool(), session.userId);
  } catch {
    return null;
  }
  if (!record || !record.isActive) return null;

  return {
    id: record.id,
    email: record.email,
    displayName: record.displayName,
    role: record.role,
  };
}

/** The landing screen each role is allowed to see. */
export function homePathForRole(role: string | undefined): string {
  return roleAtLeast(role, "manager") ? "/dashboard" : "/home";
}

/** For pages: redirect to sign-in when not authenticated / under-privileged. */
export async function requireUser(minimum: Role = "viewer"): Promise<AuthenticatedUser> {
  const user = await currentUser();
  if (!user) redirect("/signin");
  // Send the under-privileged user to a screen their role CAN see, never back to a
  // page they'll just be denied from again (which would loop).
  if (!roleAtLeast(user.role, minimum)) redirect(`${homePathForRole(user.role)}?denied=1`);
  return user;
}

/** For API routes: null means the caller must return 401/403 itself. */
export async function apiUser(minimum: Role = "viewer"): Promise<AuthenticatedUser | null> {
  const user = await currentUser();
  if (!user || !roleAtLeast(user.role, minimum)) return null;
  return user;
}

/**
 * Only relative, single-slash paths are accepted as a post-sign-in
 * destination, so `?next=` cannot be used to bounce a signed-in user to
 * another site.
 */
export function safeRedirectPath(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (value.startsWith("/signin")) return fallback;
  return value;
}
