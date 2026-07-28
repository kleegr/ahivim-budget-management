import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signSession, readSession, type SessionPayload } from "./crypto";

/**
 * Session cookie: HttpOnly, Secure in production, SameSite=Lax, 12h expiry.
 * Roles: 'admin' | 'manager' | 'viewer'.
 *
 *   viewer   read every screen and report
 *   manager  viewer + upload, commit/discard imports, resolve warnings
 *   admin    manager + user management, rate configuration, migrations
 */

export const SESSION_COOKIE = "ahivim_session";
export const SESSION_HOURS = 12;

export type Role = "admin" | "manager" | "viewer";

const RANK: Record<Role, number> = { viewer: 0, manager: 1, admin: 2 };

export function roleAtLeast(actual: string | undefined, required: Role): boolean {
  if (!actual || !(actual in RANK)) return false;
  return RANK[actual as Role] >= RANK[required];
}

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
  store.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function currentSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return readSession(store.get(SESSION_COOKIE)?.value);
}

/** For pages: redirect to sign-in when not authenticated / under-privileged. */
export async function requireSession(minimum: Role = "viewer"): Promise<SessionPayload> {
  const session = await currentSession();
  if (!session) redirect("/signin");
  if (!roleAtLeast(session.role, minimum)) redirect("/");
  return session;
}

/** For API routes: null means the caller must return 401/403 itself. */
export async function apiSession(minimum: Role = "viewer"): Promise<SessionPayload | null> {
  const session = await currentSession();
  if (!session || !roleAtLeast(session.role, minimum)) return null;
  return session;
}
