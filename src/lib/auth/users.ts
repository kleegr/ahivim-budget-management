import type { PgLikePool } from "@/lib/import/commit";
import { getPool } from "@/lib/db";
import { hashPassword, verifyPassword } from "./crypto";
import type { Role } from "./session";

/**
 * User records and the credential checks performed against them.
 *
 * Every function takes an explicit pool so the integration tests can run the
 * real queries against a real PostgreSQL rather than mocking the database.
 */

export const ROLES: Role[] = ["viewer", "manager", "admin"];

export function isRole(value: string): value is Role {
  return (ROLES as string[]).includes(value);
}

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

const SELECT_USER = `SELECT id, email, display_name, password_hash, role, is_active,
                            last_login_at::text AS last_login_at, created_at::text AS created_at
                     FROM users`;

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: isRole(row.role) ? row.role : "viewer",
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(
  pool: PgLikePool,
  email: string,
): Promise<UserRecord | null> {
  const { rows } = await pool.query<UserRow>(`${SELECT_USER} WHERE email = $1`, [
    normalizeEmail(email),
  ]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function findUserById(pool: PgLikePool, id: string): Promise<UserRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await pool.query<UserRow>(`${SELECT_USER} WHERE id = $1`, [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function listUsers(pool: PgLikePool): Promise<UserRecord[]> {
  const { rows } = await pool.query<UserRow>(`${SELECT_USER} ORDER BY email`);
  return rows.map(toUser);
}

export async function userCount(pool: PgLikePool): Promise<number> {
  const { rows } = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM users`);
  return Number(rows[0]?.c ?? 0);
}

export async function writeAudit(
  pool: PgLikePool,
  entry: {
    userId?: string | null;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      entry.userId ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* Authentication                                                              */
/* -------------------------------------------------------------------------- */

export type AuthOutcome =
  | { ok: true; user: UserRecord; bootstrapped: boolean }
  | { ok: false; reason: "invalid_credentials" | "account_disabled" };

/**
 * A constant-ish cost path for unknown emails, so response time does not
 * reveal whether an address exists.
 */
const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

/**
 * Verify a sign-in.
 *
 * BOOTSTRAP: when the users table is completely empty and BOOTSTRAP_ADMIN_EMAIL
 * / BOOTSTRAP_ADMIN_PASSWORD are configured, the first sign-in that presents
 * exactly those credentials creates the administrator. The window closes the
 * moment any user exists, there is no public signup, and no credential is ever
 * generated, returned in a response, or written to a log.
 */
export async function authenticate(
  pool: PgLikePool,
  email: string,
  password: string,
): Promise<AuthOutcome> {
  const normalized = normalizeEmail(email);
  const existing = await findUserByEmail(pool, normalized);

  if (!existing) {
    const created = await tryBootstrapAdmin(pool, normalized, password);
    if (created) return { ok: true, user: created, bootstrapped: true };
    // Burn the same work an existing user would have cost.
    await verifyPassword(password, DUMMY_HASH);
    return { ok: false, reason: "invalid_credentials" };
  }

  const valid = await verifyPassword(password, existing.passwordHash);
  if (!valid) return { ok: false, reason: "invalid_credentials" };
  if (!existing.isActive) return { ok: false, reason: "account_disabled" };

  await pool.query(`UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1`, [
    existing.id,
  ]);
  return { ok: true, user: existing, bootstrapped: false };
}

async function tryBootstrapAdmin(
  pool: PgLikePool,
  email: string,
  password: string,
): Promise<UserRecord | null> {
  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim();
  if (!bootstrapEmail || !bootstrapPassword || bootstrapPassword.length < 10) return null;
  if (email !== bootstrapEmail || password !== bootstrapPassword) return null;
  if ((await userCount(pool)) > 0) return null;

  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (email, display_name, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email, display_name, password_hash, role, is_active,
               last_login_at::text AS last_login_at, created_at::text AS created_at`,
    [email, "Administrator", passwordHash],
  );
  if (!rows[0]) return null;
  await writeAudit(pool, {
    userId: rows[0].id,
    action: "bootstrap_admin_created",
    entityType: "user",
    entityId: rows[0].id,
    metadata: { email, source: "BOOTSTRAP_ADMIN_*" },
  });
  return toUser(rows[0]);
}

/* -------------------------------------------------------------------------- */
/* Password management                                                         */
/* -------------------------------------------------------------------------- */

export const MIN_PASSWORD_LENGTH = 10;

export type PasswordChangeOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" | "incorrect_current" | "too_short" | "reused" };

export async function changePassword(
  pool: PgLikePool,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<PasswordChangeOutcome> {
  const user = await findUserById(pool, userId);
  if (!user) return { ok: false, reason: "not_found" };

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return { ok: false, reason: "incorrect_current" };
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "too_short" };
  if (await verifyPassword(newPassword, user.passwordHash)) return { ok: false, reason: "reused" };

  const passwordHash = await hashPassword(newPassword);
  await pool.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [
    passwordHash,
    userId,
  ]);
  await writeAudit(pool, {
    userId,
    action: "password_changed",
    entityType: "user",
    entityId: userId,
  });
  return { ok: true };
}

export type CreateUserOutcome =
  | { ok: true; user: UserRecord }
  | { ok: false; reason: "duplicate_email" | "too_short" | "invalid_role" | "invalid_email" };

export async function createUser(
  pool: PgLikePool,
  input: { email: string; displayName: string; password: string; role: string },
  actorId: string | null,
): Promise<CreateUserOutcome> {
  const email = normalizeEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, reason: "invalid_email" };
  if (!isRole(input.role)) return { ok: false, reason: "invalid_role" };
  if (input.password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "too_short" };
  if (await findUserByEmail(pool, email)) return { ok: false, reason: "duplicate_email" };

  const passwordHash = await hashPassword(input.password);
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (email, display_name, password_hash, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email, display_name, password_hash, role, is_active,
               last_login_at::text AS last_login_at, created_at::text AS created_at`,
    [email, input.displayName.trim() || email, passwordHash, input.role],
  );
  if (!rows[0]) return { ok: false, reason: "duplicate_email" };
  await writeAudit(pool, {
    userId: actorId,
    action: "user_created",
    entityType: "user",
    entityId: rows[0].id,
    metadata: { email, role: input.role },
  });
  return { ok: true, user: toUser(rows[0]) };
}

export async function setUserRole(
  pool: PgLikePool,
  userId: string,
  role: string,
  actorId: string | null,
): Promise<boolean> {
  if (!isRole(role)) return false;
  const { rowCount } = await pool.query(
    `UPDATE users SET role = $1, updated_at = now() WHERE id = $2`,
    [role, userId],
  );
  if (!rowCount) return false;
  await writeAudit(pool, {
    userId: actorId,
    action: "user_role_changed",
    entityType: "user",
    entityId: userId,
    metadata: { role },
  });
  return true;
}

export async function setUserActive(
  pool: PgLikePool,
  userId: string,
  isActive: boolean,
  actorId: string | null,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE users SET is_active = $1, updated_at = now() WHERE id = $2`,
    [isActive, userId],
  );
  if (!rowCount) return false;
  await writeAudit(pool, {
    userId: actorId,
    action: isActive ? "user_enabled" : "user_disabled",
    entityType: "user",
    entityId: userId,
  });
  return true;
}

/** Convenience wrappers for route handlers, which always use the real pool. */
export const db = {
  authenticate: (email: string, password: string) => authenticate(getPool(), email, password),
  findUserById: (id: string) => findUserById(getPool(), id),
  listUsers: () => listUsers(getPool()),
};
