import type { PgLikePool } from "@/lib/import/commit";
import { getPool } from "@/lib/db";
import { hashPassword, verifyPassword } from "./crypto";
import type { Role } from "./session";
import type { VisibilityPermissions } from "./access";

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

type AuditEntry = {
  userId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

async function writeAuditQuery(
  queryable: Pick<PgLikePool, "query">,
  entry: AuditEntry,
): Promise<void> {
  await queryable.query(
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

export async function writeAudit(pool: PgLikePool, entry: AuditEntry): Promise<void> {
  await writeAuditQuery(pool, entry);
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
  accessInput: Record<string, unknown> = {},
): Promise<CreateUserOutcome> {
  const email = normalizeEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, reason: "invalid_email" };
  if (!isRole(input.role)) return { ok: false, reason: "invalid_role" };
  if (input.password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "too_short" };
  if (await findUserByEmail(pool, email)) return { ok: false, reason: "duplicate_email" };

  const passwordHash = await hashPassword(input.password);
  const trustedStaff = input.role !== "viewer";
  const access = userAccessConfigFromInput(accessInput, input.role);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (
         email, display_name, password_hash, role, access_scope,
         can_see_transactions, can_see_money, can_see_hours, can_see_billed_amounts,
         can_see_employee_amounts, can_see_agency_spread, can_see_check_net,
         can_see_taxes, can_see_budgets, can_see_employee_deals, can_see_settlements,
         can_see_class_financials, can_manage_class_invoices, can_edit_documents, can_plan
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, display_name, password_hash, role, is_active,
                 last_login_at::text AS last_login_at, created_at::text AS created_at`,
      [
        email,
        input.displayName.trim() || email,
        passwordHash,
        input.role,
        trustedStaff ? "full" : "scoped",
        trustedStaff,
        trustedStaff,
        trustedStaff,
        trustedStaff,
        trustedStaff,
        trustedStaff,
        trustedStaff,
        trustedStaff,
        trustedStaff,
        false,
        false,
        trustedStaff,
        trustedStaff,
        trustedStaff,
        trustedStaff,
      ],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "duplicate_email" };
    }

    const accessCreated = await writeUserAccessConfigQuery(client, rows[0].id, access);
    if (!accessCreated) throw new Error("New user disappeared while its access was being created.");
    await writeAuditQuery(client, {
      userId: actorId,
      action: "user_created",
      entityType: "user",
      entityId: rows[0].id,
      metadata: { email, role: input.role },
    });
    await writeUserAccessAuditQuery(client, rows[0].id, access, actorId);
    await client.query("COMMIT");
    return { ok: true, user: toUser(rows[0]) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function setUserRole(
  pool: PgLikePool,
  userId: string,
  role: string,
  actorId: string | null,
): Promise<boolean> {
  return setUserRoleAndAccess(pool, userId, role, undefined, actorId);
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

/* -------------------------------------------------------------------------- */
/* Access scope (which individuals / employees / transactions a user may see)  */
/* -------------------------------------------------------------------------- */

const UUID_RE = /^[0-9a-f-]{36}$/i;

export interface UserAccessConfig extends VisibilityPermissions {
  accessScope: "full" | "scoped";
  seeAllIndividuals: boolean;
  seeAllEmployees: boolean;
  canSeeTransactions: boolean;
  canManageSettlements: boolean;
  canPlan: boolean;
  canEditDocuments: boolean;
  individualIds: string[];
  employeeIds: string[];
}

function restrictedViewerDefaults(): UserAccessConfig {
  return {
    accessScope: "scoped",
    seeAllIndividuals: false,
    seeAllEmployees: false,
    canSeeTransactions: false,
    canSeeMoney: false,
    canSeeHours: false,
    canSeeBilledAmounts: false,
    canSeeEmployeeAmounts: false,
    canSeeAgencySpread: false,
    canSeeCheckNet: false,
    canSeeTaxes: false,
    canSeeBudgets: false,
    canSeeEmployeeDeals: false,
    canSeeSettlements: false,
    canManageSettlements: false,
    canSeeClassFinancials: false,
    canManageClassInvoices: false,
    canEditDocuments: false,
    canPlan: false,
    individualIds: [],
    employeeIds: [],
  };
}

/**
 * Parse access submitted by an administrator. A viewer only receives submitted
 * grants when the request explicitly declares a scoped configuration. This is
 * deliberately stricter than the client form: stale `full` manager/admin flags
 * are never reinterpreted as an intentional viewer configuration.
 */
export function userAccessConfigFromInput(
  input: Record<string, unknown>,
  role: string,
): UserAccessConfig {
  const viewer = role === "viewer";
  if (viewer && input.accessScope !== "scoped") return restrictedViewerDefaults();

  const legacyDefault = !viewer;
  const flag = (key: string, fallback = legacyDefault): boolean => {
    const value = input[key];
    return typeof value === "boolean" ? value : fallback;
  };
  const canSeeHours = flag("canSeeHours");
  const canSeeMoney = flag("canSeeMoney");
  const canSeeClassFinancials = canSeeMoney && flag("canSeeClassFinancials");
  const canSeeSettlements = canSeeMoney && flag("canSeeSettlements", false);

  return {
    accessScope: viewer
      ? "scoped"
      : input.accessScope === "full" || input.accessScope === "scoped"
        ? input.accessScope
        : "full",
    seeAllIndividuals: flag("seeAllIndividuals", false),
    seeAllEmployees: flag("seeAllEmployees", false),
    canSeeTransactions: flag("canSeeTransactions"),
    canPlan: flag("canPlan"),
    canSeeMoney,
    canSeeHours,
    canSeeBilledAmounts: flag("canSeeBilledAmounts"),
    canSeeEmployeeAmounts: flag("canSeeEmployeeAmounts"),
    canSeeAgencySpread: flag("canSeeAgencySpread"),
    canSeeCheckNet: flag("canSeeCheckNet"),
    canSeeTaxes: flag("canSeeTaxes"),
    canSeeBudgets: canSeeHours && flag("canSeeBudgets"),
    canSeeEmployeeDeals: flag("canSeeEmployeeDeals", false),
    canSeeSettlements,
    canManageSettlements:
      canSeeSettlements && flag("canManageSettlements", false),
    canSeeClassFinancials,
    canManageClassInvoices:
      canSeeClassFinancials && flag("canManageClassInvoices"),
    canEditDocuments: flag("canEditDocuments"),
    individualIds: Array.isArray(input.individualIds) ? input.individualIds.map(String) : [],
    employeeIds: Array.isArray(input.employeeIds) ? input.employeeIds.map(String) : [],
  };
}

export interface UserWithAccess extends UserRecord, VisibilityPermissions {
  accessScope: "full" | "scoped";
  seeAllIndividuals: boolean;
  seeAllEmployees: boolean;
  canSeeTransactions: boolean;
  canManageSettlements: boolean;
  canPlan: boolean;
  canEditDocuments: boolean;
  individualCount: number;
  employeeCount: number;
}

interface VisibilityRow {
  can_see_money: boolean;
  can_see_hours: boolean;
  can_see_billed_amounts: boolean;
  can_see_employee_amounts: boolean;
  can_see_agency_spread: boolean;
  can_see_check_net: boolean;
  can_see_taxes: boolean;
  can_see_budgets: boolean;
  can_see_employee_deals: boolean;
  can_see_settlements: boolean;
  can_manage_settlements: boolean;
  can_see_class_financials: boolean;
  can_manage_class_invoices: boolean;
  can_edit_documents: boolean;
  can_plan: boolean;
}

function storedVisibility(row: VisibilityRow): VisibilityPermissions {
  const canSeeHours = row.can_see_hours !== false;
  return {
    canSeeMoney: row.can_see_money !== false,
    canSeeHours,
    canSeeBilledAmounts: row.can_see_billed_amounts !== false,
    canSeeEmployeeAmounts: row.can_see_employee_amounts !== false,
    canSeeAgencySpread: row.can_see_agency_spread !== false,
    canSeeCheckNet: row.can_see_check_net !== false,
    canSeeTaxes: row.can_see_taxes !== false,
    canSeeBudgets: canSeeHours && row.can_see_budgets !== false,
    canSeeEmployeeDeals: row.can_see_employee_deals === true,
    canSeeSettlements: row.can_see_settlements === true,
    canSeeClassFinancials:
      row.can_see_money !== false && row.can_see_class_financials === true,
    canManageClassInvoices:
      row.can_see_money !== false
      && row.can_see_class_financials === true
      && row.can_manage_class_invoices === true,
  };
}

/** Users plus a summary of each one's access, for the admin console. */
export async function listUsersWithAccess(pool: PgLikePool): Promise<UserWithAccess[]> {
  const { rows } = await pool.query<
    UserRow & VisibilityRow & {
      access_scope: string;
      see_all_individuals: boolean;
      see_all_employees: boolean;
      can_see_transactions: boolean;
      individual_count: number;
      employee_count: number;
    }
  >(
    `SELECT u.id, u.email, u.display_name, u.password_hash, u.role, u.is_active,
            u.last_login_at::text AS last_login_at, u.created_at::text AS created_at,
            u.access_scope, u.see_all_individuals, u.see_all_employees, u.can_see_transactions,
            u.can_see_money, u.can_see_hours, u.can_see_billed_amounts,
            u.can_see_employee_amounts, u.can_see_agency_spread, u.can_see_check_net,
            u.can_see_taxes, u.can_see_budgets, u.can_see_employee_deals, u.can_see_settlements,
            u.can_manage_settlements,
            u.can_see_class_financials, u.can_manage_class_invoices, u.can_edit_documents, u.can_plan,
            (SELECT count(*) FROM user_individual_access a WHERE a.user_id = u.id)::int AS individual_count,
            (SELECT count(*) FROM user_employee_access a WHERE a.user_id = u.id)::int AS employee_count
       FROM users u
      ORDER BY u.email`,
  );
  return rows.map((r) => ({
    ...toUser(r),
    accessScope: r.access_scope === "scoped" ? "scoped" : "full",
    seeAllIndividuals: r.see_all_individuals === true,
    seeAllEmployees: r.see_all_employees === true,
    canSeeTransactions: r.can_see_transactions !== false,
    canManageSettlements:
      r.can_see_settlements === true && r.can_manage_settlements === true,
    canPlan: r.can_plan === true,
    canEditDocuments: r.can_edit_documents === true,
    ...storedVisibility(r),
    individualCount: Number(r.individual_count ?? 0),
    employeeCount: Number(r.employee_count ?? 0),
  }));
}

/** The full access configuration for one user (for the edit form). */
export async function getUserAccessConfig(
  pool: PgLikePool,
  userId: string,
): Promise<UserAccessConfig | null> {
  const { rows } = await pool.query<VisibilityRow & {
    access_scope: string;
    see_all_individuals: boolean;
    see_all_employees: boolean;
    can_see_transactions: boolean;
  }>(
    `SELECT access_scope, see_all_individuals, see_all_employees, can_see_transactions,
            can_see_money, can_see_hours, can_see_billed_amounts,
            can_see_employee_amounts, can_see_agency_spread, can_see_check_net,
            can_see_taxes, can_see_budgets, can_see_employee_deals, can_see_settlements,
            can_manage_settlements,
            can_see_class_financials, can_manage_class_invoices, can_edit_documents, can_plan
       FROM users WHERE id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u) return null;
  const individualIds = (
    await pool.query<{ individual_id: string }>(
      `SELECT individual_id FROM user_individual_access WHERE user_id = $1`,
      [userId],
    )
  ).rows.map((r) => r.individual_id);
  const employeeIds = (
    await pool.query<{ employee_id: string }>(
      `SELECT employee_id FROM user_employee_access WHERE user_id = $1`,
      [userId],
    )
  ).rows.map((r) => r.employee_id);
  return {
    accessScope: u.access_scope === "scoped" ? "scoped" : "full",
    seeAllIndividuals: u.see_all_individuals === true,
    seeAllEmployees: u.see_all_employees === true,
    canSeeTransactions: u.can_see_transactions !== false,
    canManageSettlements:
      u.can_see_settlements === true && u.can_manage_settlements === true,
    canPlan: u.can_plan === true,
    canEditDocuments: u.can_edit_documents === true,
    ...storedVisibility(u),
    individualIds,
    employeeIds,
  };
}

function normalizeAccessConfigForRole(
  config: UserAccessConfig | undefined,
  role: Role,
): UserAccessConfig {
  return userAccessConfigFromInput(config ? { ...config } : {}, role);
}

function validAccessIds(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => UUID_RE.test(value)))];
}

/** Write one already-normalized access record inside the caller's transaction. */
async function writeUserAccessConfigQuery(
  queryable: Pick<PgLikePool, "query">,
  userId: string,
  config: UserAccessConfig,
): Promise<boolean> {
  const scope = config.accessScope === "scoped" ? "scoped" : "full";
  const individualIds = validAccessIds(config.individualIds);
  const employeeIds = validAccessIds(config.employeeIds);
  const canSeeMoney = config.canSeeMoney === true;
  const canSeeHours = config.canSeeHours === true;
  const canSeeBudgets = canSeeHours && config.canSeeBudgets === true;
  const canSeeClassFinancials = canSeeMoney && config.canSeeClassFinancials === true;
  const canSeeSettlements = canSeeMoney && config.canSeeSettlements === true;
  const canManageSettlements = canSeeSettlements && config.canManageSettlements === true;
  const canManageClassInvoices =
    canSeeClassFinancials && config.canManageClassInvoices === true;

  const { rowCount } = await queryable.query(
    `UPDATE users
        SET access_scope = $1,
            see_all_individuals = $2,
            see_all_employees = $3,
            can_see_transactions = $4,
            can_see_money = $5,
            can_see_hours = $6,
            can_see_billed_amounts = $7,
            can_see_employee_amounts = $8,
            can_see_agency_spread = $9,
            can_see_check_net = $10,
            can_see_taxes = $11,
            can_see_budgets = $12,
            can_see_employee_deals = $13,
            can_see_settlements = $14,
            can_manage_settlements = $15,
            can_see_class_financials = $16,
            can_manage_class_invoices = $17,
            can_edit_documents = $18,
            can_plan = $19,
            updated_at = now()
      WHERE id = $20`,
    [
      scope,
      config.seeAllIndividuals === true,
      config.seeAllEmployees === true,
      config.canSeeTransactions === true,
      canSeeMoney,
      canSeeHours,
      canSeeMoney && config.canSeeBilledAmounts === true,
      canSeeMoney && config.canSeeEmployeeAmounts === true,
      canSeeMoney && config.canSeeAgencySpread === true,
      canSeeMoney && config.canSeeCheckNet === true,
      canSeeMoney && config.canSeeTaxes === true,
      canSeeBudgets,
      canSeeMoney && config.canSeeEmployeeDeals === true,
      canSeeSettlements,
      canManageSettlements,
      canSeeClassFinancials,
      canManageClassInvoices,
      config.canEditDocuments === true,
      config.canPlan === true,
      userId,
    ],
  );
  if (!rowCount) return false;

  await queryable.query(`DELETE FROM user_individual_access WHERE user_id = $1`, [userId]);
  await queryable.query(`DELETE FROM user_employee_access WHERE user_id = $1`, [userId]);
  if (scope === "scoped" && individualIds.length > 0) {
    await queryable.query(
      `INSERT INTO user_individual_access (user_id, individual_id)
       SELECT $1, x FROM unnest($2::uuid[]) x
       ON CONFLICT DO NOTHING`,
      [userId, individualIds],
    );
  }
  if (scope === "scoped" && employeeIds.length > 0) {
    await queryable.query(
      `INSERT INTO user_employee_access (user_id, employee_id)
       SELECT $1, x FROM unnest($2::uuid[]) x
       ON CONFLICT DO NOTHING`,
      [userId, employeeIds],
    );
  }
  return true;
}

async function writeUserAccessAuditQuery(
  queryable: Pick<PgLikePool, "query">,
  userId: string,
  config: UserAccessConfig,
  actorId: string | null,
): Promise<void> {
  const individualIds = validAccessIds(config.individualIds);
  const employeeIds = validAccessIds(config.employeeIds);
  const canSeeMoney = config.canSeeMoney === true;
  const canSeeHours = config.canSeeHours === true;
  const canSeeClassFinancials = canSeeMoney && config.canSeeClassFinancials === true;
  const canSeeSettlements = canSeeMoney && config.canSeeSettlements === true;
  await writeAuditQuery(queryable, {
    userId: actorId,
    action: "user_access_changed",
    entityType: "user",
    entityId: userId,
    metadata: {
      scope: config.accessScope,
      seeAllIndividuals: config.seeAllIndividuals === true,
      seeAllEmployees: config.seeAllEmployees === true,
      canSeeTransactions: config.canSeeTransactions === true,
      canSeeMoney,
      canSeeHours,
      canSeeBilledAmounts: canSeeMoney && config.canSeeBilledAmounts === true,
      canSeeEmployeeAmounts: canSeeMoney && config.canSeeEmployeeAmounts === true,
      canSeeAgencySpread: canSeeMoney && config.canSeeAgencySpread === true,
      canSeeCheckNet: canSeeMoney && config.canSeeCheckNet === true,
      canSeeTaxes: canSeeMoney && config.canSeeTaxes === true,
      canSeeBudgets: canSeeHours && config.canSeeBudgets === true,
      canSeeEmployeeDeals: canSeeMoney && config.canSeeEmployeeDeals === true,
      canSeeSettlements,
      canManageSettlements: canSeeSettlements && config.canManageSettlements === true,
      canSeeClassFinancials,
      canManageClassInvoices:
        canSeeClassFinancials && config.canManageClassInvoices === true,
      canEditDocuments: config.canEditDocuments === true,
      canPlan: config.canPlan === true,
      individuals: individualIds.length,
      employees: employeeIds.length,
    },
  });
}

/**
 * Atomically replace role and access. Demoting to viewer always writes a
 * least-privilege scoped record unless a scoped configuration is supplied in
 * this same operation.
 */
export async function setUserRoleAndAccess(
  pool: PgLikePool,
  userId: string,
  role: string,
  config: UserAccessConfig | undefined,
  actorId: string | null,
): Promise<boolean> {
  if (!isRole(role)) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ role: string }>(
      `SELECT role FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }

    const normalizedAccess = role === "viewer"
      ? normalizeAccessConfigForRole(config, role)
      : config
        ? normalizeAccessConfigForRole(config, role)
        : undefined;
    const { rowCount } = await client.query(
      `UPDATE users SET role = $1, updated_at = now() WHERE id = $2`,
      [role, userId],
    );
    if (!rowCount) throw new Error("User disappeared while its role was being updated.");
    if (normalizedAccess) {
      const accessUpdated = await writeUserAccessConfigQuery(client, userId, normalizedAccess);
      if (!accessUpdated) throw new Error("User disappeared while its access was being updated.");
    }

    await writeAuditQuery(client, {
      userId: actorId,
      action: "user_role_changed",
      entityType: "user",
      entityId: userId,
      metadata: { previousRole: rows[0].role, role },
    });
    if (normalizedAccess) {
      await writeUserAccessAuditQuery(client, userId, normalizedAccess, actorId);
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Replace one user's access flags and grants as a single transaction. */
export async function setUserAccessConfig(
  pool: PgLikePool,
  userId: string,
  config: UserAccessConfig,
  actorId: string | null,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ role: string }>(
      `SELECT role FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    const role = isRole(rows[0].role) ? rows[0].role : "viewer";
    const normalizedAccess = normalizeAccessConfigForRole(config, role);
    const updated = await writeUserAccessConfigQuery(client, userId, normalizedAccess);
    if (!updated) throw new Error("User disappeared while its access was being updated.");
    await writeUserAccessAuditQuery(client, userId, normalizedAccess, actorId);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Admin password reset — sets a new password without knowing the old one. */
export async function setUserPassword(
  pool: PgLikePool,
  userId: string,
  newPassword: string,
  actorId: string | null,
): Promise<{ ok: true } | { ok: false; reason: "too_short" | "not_found" }> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "too_short" };
  const user = await findUserById(pool, userId);
  if (!user) return { ok: false, reason: "not_found" };
  const passwordHash = await hashPassword(newPassword);
  await pool.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [
    passwordHash,
    userId,
  ]);
  await writeAudit(pool, {
    userId: actorId,
    action: "user_password_reset_by_admin",
    entityType: "user",
    entityId: userId,
  });
  return { ok: true };
}

/** Convenience wrappers for route handlers, which always use the real pool. */
export const db = {
  authenticate: (email: string, password: string) => authenticate(getPool(), email, password),
  findUserById: (id: string) => findUserById(getPool(), id),
  listUsers: () => listUsers(getPool()),
};
