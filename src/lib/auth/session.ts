import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import {
  readImpersonation,
  readSession,
  signImpersonation,
  signSession,
  type ImpersonationPayload,
  type SessionPayload,
} from "./crypto";

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
export const IMPERSONATION_COOKIE = "ahivim_owner_return";
export const IMPERSONATION_MINUTES = 60;

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

type SessionUser = {
  id: string;
  role: string;
  displayName: string;
};

function cookieSecurity(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

function sessionPayload(
  user: SessionUser,
  exp: number,
  impersonatorUserId?: string,
): SessionPayload {
  return {
    userId: user.id,
    role: user.role,
    displayName: user.displayName,
    ...(impersonatorUserId ? { impersonatorUserId } : {}),
    exp,
  };
}

export async function createSessionCookie(user: SessionUser): Promise<void> {
  const payload = sessionPayload(
    user,
    Date.now() + SESSION_HOURS * 60 * 60 * 1000,
  );
  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    signSession(payload),
    cookieSecurity(SESSION_HOURS * 60 * 60),
  );
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", cookieSecurity(0));
}

export async function clearImpersonationCookie(): Promise<void> {
  const store = await cookies();
  store.set(IMPERSONATION_COOKIE, "", cookieSecurity(0));
}

export async function clearAuthenticationCookies(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", cookieSecurity(0));
  store.set(IMPERSONATION_COOKIE, "", cookieSecurity(0));
}

export async function currentSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return readSession(store.get(SESSION_COOKIE)?.value);
}

export async function currentImpersonationSession(): Promise<ImpersonationPayload | null> {
  const store = await cookies();
  return readImpersonation(store.get(IMPERSONATION_COOKIE)?.value);
}

/** Replace the owner with the target while retaining a short, signed return identity. */
export async function createImpersonationSession(
  owner: SessionUser,
  target: SessionUser,
  ownerSessionExpiresAt: number,
): Promise<ImpersonationPayload> {
  const now = Date.now();
  const exp = Math.min(
    ownerSessionExpiresAt,
    now + IMPERSONATION_MINUTES * 60 * 1000,
  );
  if (owner.id === target.id || exp <= now) {
    throw new Error("This session cannot start a user preview.");
  }

  const payload: ImpersonationPayload = {
    ownerUserId: owner.id,
    targetUserId: target.id,
    ownerSessionExpiresAt,
    exp,
  };
  const maxAge = Math.max(1, Math.floor((exp - now) / 1000));
  const store = await cookies();
  store.set(IMPERSONATION_COOKIE, signImpersonation(payload), cookieSecurity(maxAge));
  store.set(
    SESSION_COOKIE,
    signSession(sessionPayload(target, exp, owner.id)),
    cookieSecurity(maxAge),
  );
  return payload;
}

/** Restore the owner without extending the session they originally signed in with. */
export async function restoreOwnerSession(
  owner: SessionUser,
  impersonation: ImpersonationPayload,
): Promise<boolean> {
  const now = Date.now();
  if (
    owner.id !== impersonation.ownerUserId
    || impersonation.ownerSessionExpiresAt <= now
  ) return false;

  const maxAge = Math.max(
    1,
    Math.floor((impersonation.ownerSessionExpiresAt - now) / 1000),
  );
  const store = await cookies();
  store.set(
    SESSION_COOKIE,
    signSession(sessionPayload(owner, impersonation.ownerSessionExpiresAt)),
    cookieSecurity(maxAge),
  );
  store.set(IMPERSONATION_COOKIE, "", cookieSecurity(0));
  return true;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface CurrentImpersonation {
  owner: AuthenticatedUser;
  target: AuthenticatedUser;
  expiresAt: number;
}

export function impersonationAuthorityIsValid(
  impersonation: ImpersonationPayload,
  effectiveSession: SessionPayload,
  owner: { id: string; role: string; isActive: boolean } | null,
): boolean {
  return impersonation.targetUserId === effectiveSession.userId
    && effectiveSession.impersonatorUserId === impersonation.ownerUserId
    && owner?.id === impersonation.ownerUserId
    && owner.isActive
    && owner.role === "admin";
}

/**
 * Authoritative check. Verifies the cookie signature and expiry, then confirms
 * the account still exists, is still active, and still holds the role the
 * cookie claims. Returns null rather than throwing so callers choose their own
 * failure mode (redirect for pages, status code for APIs).
 */
async function loadAuthenticationContext(): Promise<{
  user: AuthenticatedUser;
  impersonation: CurrentImpersonation | null;
} | null> {
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

  const user: AuthenticatedUser = {
    id: record.id,
    email: record.email,
    displayName: record.displayName,
    role: record.role,
  };

  const store = await cookies();
  const rawImpersonation = store.get(IMPERSONATION_COOKIE)?.value;
  if (!rawImpersonation) {
    return session.impersonatorUserId ? null : { user, impersonation: null };
  }

  const impersonation = readImpersonation(rawImpersonation);
  if (!impersonation || !session.impersonatorUserId) return null;

  const ownerRecord = await findUserById(getPool(), impersonation.ownerUserId).catch(() => null);
  if (!ownerRecord || !impersonationAuthorityIsValid(impersonation, session, ownerRecord)) {
    return null;
  }

  return {
    user,
    impersonation: {
      owner: {
        id: ownerRecord.id,
        email: ownerRecord.email,
        displayName: ownerRecord.displayName,
        role: ownerRecord.role,
      },
      target: user,
      expiresAt: impersonation.exp,
    },
  };
}

/**
 * Layouts and pages both authorize themselves. React's request-scoped cache
 * keeps that defense in depth without repeating the same database lookup on a
 * single render; a new navigation still performs a fresh authoritative read.
 */
const currentAuthentication = cache(loadAuthenticationContext);

export async function currentUser(): Promise<AuthenticatedUser | null> {
  return (await currentAuthentication())?.user ?? null;
}

export async function currentImpersonation(): Promise<CurrentImpersonation | null> {
  return (await currentAuthentication())?.impersonation ?? null;
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
