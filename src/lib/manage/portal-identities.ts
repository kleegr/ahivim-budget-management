import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import {
  isGlobalPortalRole,
  isPortalCapability,
  portalCapabilityAllowedForRole,
  type GlobalPortalRole,
  type IndividualRelationship,
  type PortalCapability,
} from "@/lib/auth/portal-access";
import { recordChange } from "./audit";
import { fail, ok, type Result } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INDIVIDUAL_RELATIONSHIPS: IndividualRelationship[] = ["self", "parent", "guardian", "representative"];

interface PortalPolicyInput {
  capabilityGrants?: string[];
  capabilityDenials?: string[];
}

function validatePolicy(
  role: GlobalPortalRole,
  input: PortalPolicyInput,
): Result<{ grants: PortalCapability[]; denials: PortalCapability[] }> {
  const grants = input.capabilityGrants ?? [];
  const denials = input.capabilityDenials ?? [];
  const all = [...grants, ...denials];
  if (all.some((value) => !isPortalCapability(value))) {
    return fail("validation", "One or more portal capabilities are not recognized.");
  }
  if (all.some((value) => !portalCapabilityAllowedForRole(role, value as PortalCapability))) {
    return fail("validation", "That capability cannot be assigned to this portal relationship.");
  }
  const denied = new Set(denials);
  if (grants.some((value) => denied.has(value))) {
    return fail("validation", "A capability cannot be both granted and denied.");
  }
  return ok({
    grants: [...new Set(grants)] as PortalCapability[],
    denials: [...new Set(denials)] as PortalCapability[],
  });
}

async function inTransaction<T>(pool: PgLikePool, work: (client: PgLikeClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface IndividualPortalAssignment {
  userId: string;
  displayName: string;
  email: string;
  individualId: string;
  individualName: string;
  relationship: IndividualRelationship;
  isActive: boolean;
  capabilityGrants: PortalCapability[];
  capabilityDenials: PortalCapability[];
}

export interface EmployeePortalAssignment {
  userId: string;
  displayName: string;
  email: string;
  employeeId: string;
  employeeName: string;
  isActive: boolean;
  capabilityGrants: PortalCapability[];
  capabilityDenials: PortalCapability[];
}

export interface GlobalPortalRoleAssignment {
  userId: string;
  displayName: string;
  email: string;
  role: GlobalPortalRole;
  isActive: boolean;
  updatedAt: string;
}

export async function listGlobalPortalRoleAssignments(pool: PgLikePool): Promise<GlobalPortalRoleAssignment[]> {
  const { rows } = await pool.query<{
    user_id: string;
    display_name: string;
    email: string;
    portal_role: string;
    is_active: boolean;
    updated_at: string;
  }>(
    `SELECT role.user_id, account.display_name, account.email, role.portal_role,
            role.is_active, role.updated_at::text AS updated_at
       FROM user_portal_roles role
       JOIN users account ON account.id = role.user_id
      ORDER BY (role.is_active = false), account.display_name, role.portal_role`,
  );
  return rows.flatMap((row) => {
    if (!isGlobalPortalRole(row.portal_role)) return [];
    return [{
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
      role: row.portal_role,
      isActive: row.is_active,
      updatedAt: row.updated_at,
    }];
  });
}

export async function setGlobalPortalRoleAssignment(
  pool: PgLikePool,
  input: { userId: string; role: GlobalPortalRole; isActive?: boolean },
  actorId: string,
  reason?: string | null,
): Promise<Result<{ userId: string; role: GlobalPortalRole; isActive: boolean }>> {
  return inTransaction(pool, (client) =>
    setGlobalPortalRoleAssignmentQuery(client, input, actorId, reason));
}

/** Write a global portal role on an existing caller-owned transaction. */
export async function setGlobalPortalRoleAssignmentQuery(
  queryable: Pick<PgLikePool, "query">,
  input: { userId: string; role: GlobalPortalRole; isActive?: boolean },
  actorId: string,
  reason?: string | null,
): Promise<Result<{ userId: string; role: GlobalPortalRole; isActive: boolean }>> {
  if (!UUID.test(input.userId) || !isGlobalPortalRole(input.role)) {
    return fail("validation", "Choose a valid account and portal role.");
  }
  const isActive = input.isActive ?? true;
  const account = await queryable.query<{ id: string; is_active: boolean }>(
    `SELECT id, is_active FROM users WHERE id = $1`,
    [input.userId],
  );
  if (!account.rows[0] || (isActive && !account.rows[0].is_active)) {
    return fail("not_found", "That active account no longer exists.");
  }

  if (input.role === "owner" && !isActive) {
    await queryable.query("LOCK TABLE user_portal_roles IN SHARE ROW EXCLUSIVE MODE");
    const owners = await queryable.query<{ active_owner_count: number | string }>(
      `SELECT COUNT(*)::int AS active_owner_count
         FROM user_portal_roles
        WHERE portal_role = 'owner' AND is_active = true AND user_id <> $1`,
      [input.userId],
    );
    if (Number(owners.rows[0]?.active_owner_count ?? 0) === 0) {
      return fail("conflict", "At least one active owner account is required.");
    }
  }

  await queryable.query(
    `INSERT INTO user_portal_roles
       (user_id, portal_role, is_active, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (user_id, portal_role) DO UPDATE SET
       is_active = EXCLUDED.is_active,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = now()`,
    [input.userId, input.role, isActive, actorId],
  );
  await recordChange(queryable, {
    actorId,
    action: "global_portal_role_set",
    entityType: "user",
    entityId: input.userId,
    next: { role: input.role, isActive },
    reason,
  });
  return ok({ userId: input.userId, role: input.role, isActive });
}

export async function listIndividualPortalAssignments(pool: PgLikePool): Promise<IndividualPortalAssignment[]> {
  const { rows } = await pool.query<{
    user_id: string;
    display_name: string;
    email: string;
    individual_id: string;
    individual_name: string;
    relationship_type: string;
    is_active: boolean;
    capability_grants: string[];
    capability_denials: string[];
  }>(
    `SELECT rel.user_id, u.display_name, u.email, rel.individual_id,
            i.display_name AS individual_name, rel.relationship_type, rel.is_active,
            rel.capability_grants, rel.capability_denials
       FROM user_individual_relationships rel
       JOIN users u ON u.id = rel.user_id
       JOIN individuals i ON i.id = rel.individual_id
      ORDER BY (rel.is_active = false), u.display_name, i.display_name`,
  );
  return rows.flatMap((row) => {
    if (!INDIVIDUAL_RELATIONSHIPS.includes(row.relationship_type as IndividualRelationship)) return [];
    return [{
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
      individualId: row.individual_id,
      individualName: row.individual_name,
      relationship: row.relationship_type as IndividualRelationship,
      isActive: row.is_active,
      capabilityGrants: row.capability_grants.filter(isPortalCapability),
      capabilityDenials: row.capability_denials.filter(isPortalCapability),
    }];
  });
}

export async function listEmployeePortalAssignments(pool: PgLikePool): Promise<EmployeePortalAssignment[]> {
  const { rows } = await pool.query<{
    user_id: string;
    display_name: string;
    email: string;
    employee_id: string;
    employee_name: string;
    is_active: boolean;
    capability_grants: string[];
    capability_denials: string[];
  }>(
    `SELECT rel.user_id, u.display_name, u.email, rel.employee_id,
            e.display_name AS employee_name, rel.is_active,
            rel.capability_grants, rel.capability_denials
       FROM user_employee_relationships rel
       JOIN users u ON u.id = rel.user_id
       JOIN employees e ON e.id = rel.employee_id
      ORDER BY (rel.is_active = false), u.display_name, e.display_name`,
  );
  return rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    isActive: row.is_active,
    capabilityGrants: row.capability_grants.filter(isPortalCapability),
    capabilityDenials: row.capability_denials.filter(isPortalCapability),
  }));
}

export interface IndividualPortalAssignmentInput extends PortalPolicyInput {
  userId: string;
  individualId: string;
  relationship: IndividualRelationship;
  isActive?: boolean;
}

export async function setIndividualPortalAssignment(
  pool: PgLikePool,
  input: IndividualPortalAssignmentInput,
  actorId: string,
  reason?: string | null,
): Promise<Result<{ userId: string; individualId: string; relationship: IndividualRelationship }>> {
  return inTransaction(pool, (client) =>
    setIndividualPortalAssignmentQuery(client, input, actorId, reason));
}

/** Write a direct individual/guardian relationship on the caller's transaction. */
export async function setIndividualPortalAssignmentQuery(
  queryable: Pick<PgLikePool, "query">,
  input: IndividualPortalAssignmentInput,
  actorId: string,
  reason?: string | null,
): Promise<Result<{ userId: string; individualId: string; relationship: IndividualRelationship }>> {
  if (!UUID.test(input.userId) || !UUID.test(input.individualId)) return fail("validation", "Choose a valid user and individual.");
  if (!INDIVIDUAL_RELATIONSHIPS.includes(input.relationship)) return fail("validation", "Choose a valid relationship.");
  const role: GlobalPortalRole = input.relationship === "self" ? "individual" : "parent";
  const configured = validatePolicy(role, input);
  if (!configured.ok) return configured;
  const related = await queryable.query(
    `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND is_active = true) AS user_exists,
            EXISTS (SELECT 1 FROM individuals WHERE id = $2) AS person_exists`,
    [input.userId, input.individualId],
  );
  const found = related.rows[0] as { user_exists?: boolean; person_exists?: boolean } | undefined;
  if (!found?.user_exists || !found.person_exists) return fail("not_found", "That active user or individual no longer exists.");

  await queryable.query(
    `INSERT INTO user_individual_relationships
       (user_id, individual_id, relationship_type, is_active,
        capability_grants, capability_denials, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7, $7)
     ON CONFLICT (user_id, individual_id, relationship_type) DO UPDATE SET
       is_active = EXCLUDED.is_active,
       capability_grants = EXCLUDED.capability_grants,
       capability_denials = EXCLUDED.capability_denials,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = now()`,
    [
      input.userId,
      input.individualId,
      input.relationship,
      input.isActive ?? true,
      configured.data.grants,
      configured.data.denials,
      actorId,
    ],
  );
  await recordChange(queryable, {
    actorId,
    action: "individual_portal_access_set",
    entityType: "individual",
    entityId: input.individualId,
    next: { userId: input.userId, relationship: input.relationship, isActive: input.isActive ?? true, ...configured.data },
    reason,
  });
  return ok({ userId: input.userId, individualId: input.individualId, relationship: input.relationship });
}

export interface EmployeePortalAssignmentInput extends PortalPolicyInput {
  userId: string;
  employeeId: string;
  isActive?: boolean;
}

export async function setEmployeePortalAssignment(
  pool: PgLikePool,
  input: EmployeePortalAssignmentInput,
  actorId: string,
  reason?: string | null,
): Promise<Result<{ userId: string; employeeId: string }>> {
  return inTransaction(pool, (client) =>
    setEmployeePortalAssignmentQuery(client, input, actorId, reason));
}

/** Write an employee self-service relationship on the caller's transaction. */
export async function setEmployeePortalAssignmentQuery(
  queryable: Pick<PgLikePool, "query">,
  input: EmployeePortalAssignmentInput,
  actorId: string,
  reason?: string | null,
): Promise<Result<{ userId: string; employeeId: string }>> {
  if (!UUID.test(input.userId) || !UUID.test(input.employeeId)) return fail("validation", "Choose a valid user and employee.");
  const configured = validatePolicy("employee", input);
  if (!configured.ok) return configured;
  const related = await queryable.query(
    `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND is_active = true) AS user_exists,
            EXISTS (SELECT 1 FROM employees WHERE id = $2) AS person_exists`,
    [input.userId, input.employeeId],
  );
  const found = related.rows[0] as { user_exists?: boolean; person_exists?: boolean } | undefined;
  if (!found?.user_exists || !found.person_exists) return fail("not_found", "That active user or employee no longer exists.");

  await queryable.query(
    `INSERT INTO user_employee_relationships
       (user_id, employee_id, relationship_type, is_active,
        capability_grants, capability_denials, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, 'self', $3, $4::text[], $5::text[], $6, $6)
     ON CONFLICT (user_id, employee_id, relationship_type) DO UPDATE SET
       is_active = EXCLUDED.is_active,
       capability_grants = EXCLUDED.capability_grants,
       capability_denials = EXCLUDED.capability_denials,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = now()`,
    [input.userId, input.employeeId, input.isActive ?? true, configured.data.grants, configured.data.denials, actorId],
  );
  await recordChange(queryable, {
    actorId,
    action: "employee_portal_access_set",
    entityType: "employee",
    entityId: input.employeeId,
    next: { userId: input.userId, isActive: input.isActive ?? true, ...configured.data },
    reason,
  });
  return ok({ userId: input.userId, employeeId: input.employeeId });
}
