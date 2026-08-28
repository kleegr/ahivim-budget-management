import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import {
  isAgencyPortalRole,
  isPortalCapability,
  portalCapabilityAllowedForRole,
  type AgencyPortalRole,
  type PortalCapability,
} from "@/lib/auth/portal-access";
import { recordChange } from "./audit";
import { fail, ok, type Result } from "./errors";

export const AGENCY_STATUSES = ["active", "inactive", "archived"] as const;
export type AgencyStatus = (typeof AGENCY_STATUSES)[number];

export interface AgencyRecord {
  id: string;
  code: string;
  name: string;
  status: AgencyStatus;
  isHomeAgency: boolean;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  individualCount: number;
  employeeCount: number;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

interface AgencyRow {
  id: string;
  code: string;
  name: string;
  status: AgencyStatus;
  is_home_agency: boolean;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  individual_count: number | string;
  employee_count: number | string;
  access_count: number | string;
  created_at: string;
  updated_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function inTransaction<T>(pool: PgLikePool, work: (client: PgLikeClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const SELECT_AGENCY = `
  SELECT a.id, a.code, a.name, a.status, a.is_home_agency,
         a.contact_name, a.contact_email, a.contact_phone, a.notes,
         a.created_at::text AS created_at, a.updated_at::text AS updated_at,
         (SELECT COUNT(*)::int FROM agency_individuals ai
           WHERE ai.agency_id = a.id AND ai.is_active = true
             AND ai.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
             AND (ai.effective_to IS NULL OR ai.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)) AS individual_count,
         (SELECT COUNT(*)::int FROM agency_employees ae
           WHERE ae.agency_id = a.id AND ae.is_active = true
             AND ae.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
             AND (ae.effective_to IS NULL OR ae.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)) AS employee_count,
         (SELECT COUNT(DISTINCT uaa.user_id)::int FROM user_agency_access uaa
           WHERE uaa.agency_id = a.id AND uaa.is_active = true) AS access_count
    FROM agencies a`;

function toAgency(row: AgencyRow): AgencyRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    isHomeAgency: row.is_home_agency,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    notes: row.notes,
    individualCount: Number(row.individual_count),
    employeeCount: Number(row.employee_count),
    accessCount: Number(row.access_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeCode(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "_")
    : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function listAgencies(pool: PgLikePool): Promise<AgencyRecord[]> {
  const { rows } = await pool.query<AgencyRow>(
    `${SELECT_AGENCY} ORDER BY a.is_home_agency DESC, (a.status = 'archived'), a.name`,
  );
  return rows.map(toAgency);
}

export async function getAgency(pool: PgLikePool, id: string): Promise<AgencyRecord | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query<AgencyRow>(`${SELECT_AGENCY} WHERE a.id = $1`, [id]);
  return rows[0] ? toAgency(rows[0]) : null;
}

export interface AgencyInput {
  code: string;
  name: string;
  status?: AgencyStatus;
  isHomeAgency?: boolean;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
}

function validateAgency(input: AgencyInput): string | null {
  if (!normalizeCode(input.code)) return "An agency code is required.";
  if (!input.name?.trim()) return "An agency name is required.";
  if (input.status && !AGENCY_STATUSES.includes(input.status)) return "Choose a valid agency status.";
  const email = nullableText(input.contactEmail);
  if (email && !EMAIL.test(email)) return "Enter a valid contact email address.";
  if (input.isHomeAgency && input.status === "archived") return "The home agency cannot be archived.";
  return null;
}

export async function createAgency(
  pool: PgLikePool,
  input: AgencyInput,
  actorId: string,
  reason?: string | null,
): Promise<Result<AgencyRecord>> {
  const message = validateAgency(input);
  if (message) return fail("validation", message);
  const code = normalizeCode(input.code);
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agencies
         (code, name, status, is_home_agency, contact_name, contact_email,
          contact_phone, notes, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING id`,
      [
        code,
        input.name.trim(),
        input.status ?? "active",
        input.isHomeAgency ?? false,
        nullableText(input.contactName),
        nullableText(input.contactEmail)?.toLowerCase() ?? null,
        nullableText(input.contactPhone),
        nullableText(input.notes),
        actorId,
      ],
    );
    const agency = await getAgency(pool, rows[0]!.id);
    if (!agency) return fail("not_found", "The new agency could not be loaded.");
    await recordChange(pool, {
      actorId,
      action: "agency_created",
      entityType: "agency",
      entityId: agency.id,
      next: agency,
      reason,
    });
    return ok(agency);
  } catch (error) {
    if (isUniqueViolation(error)) return fail("conflict", "That agency code or home-agency setting is already in use.");
    throw error;
  }
}

export async function updateAgency(
  pool: PgLikePool,
  id: string,
  input: Partial<AgencyInput>,
  actorId: string,
  reason?: string | null,
): Promise<Result<AgencyRecord>> {
  const before = await getAgency(pool, id);
  if (!before) return fail("not_found", "That agency no longer exists.");
  const nextInput: AgencyInput = {
    code: input.code ?? before.code,
    name: input.name ?? before.name,
    status: input.status ?? before.status,
    isHomeAgency: input.isHomeAgency ?? before.isHomeAgency,
    contactName: input.contactName === undefined ? before.contactName : input.contactName,
    contactEmail: input.contactEmail === undefined ? before.contactEmail : input.contactEmail,
    contactPhone: input.contactPhone === undefined ? before.contactPhone : input.contactPhone,
    notes: input.notes === undefined ? before.notes : input.notes,
  };
  const message = validateAgency(nextInput);
  if (message) return fail("validation", message);
  try {
    await pool.query(
      `UPDATE agencies
          SET code = $2, name = $3, status = $4, is_home_agency = $5,
              contact_name = $6, contact_email = $7, contact_phone = $8,
              notes = $9, updated_by_user_id = $10, updated_at = now()
        WHERE id = $1`,
      [
        id,
        normalizeCode(nextInput.code),
        nextInput.name.trim(),
        nextInput.status,
        nextInput.isHomeAgency,
        nullableText(nextInput.contactName),
        nullableText(nextInput.contactEmail)?.toLowerCase() ?? null,
        nullableText(nextInput.contactPhone),
        nullableText(nextInput.notes),
        actorId,
      ],
    );
    const after = await getAgency(pool, id);
    if (!after) return fail("not_found", "That agency no longer exists.");
    await recordChange(pool, {
      actorId,
      action: "agency_updated",
      entityType: "agency",
      entityId: id,
      previous: before,
      next: after,
      reason,
    });
    return ok(after);
  } catch (error) {
    if (isUniqueViolation(error)) return fail("conflict", "That agency code or home-agency setting is already in use.");
    throw error;
  }
}

function capabilityPolicy(
  role: AgencyPortalRole,
  grants: readonly string[] | undefined,
  denials: readonly string[] | undefined,
): Result<{ grants: PortalCapability[]; denials: PortalCapability[] }> {
  const all = [...(grants ?? []), ...(denials ?? [])];
  if (all.some((item) => !isPortalCapability(item))) {
    return fail("validation", "One or more portal capabilities are not recognized.");
  }
  if (all.some((item) => !portalCapabilityAllowedForRole(role, item as PortalCapability))) {
    return fail("validation", "That capability cannot be assigned to this agency role.");
  }
  const denied = new Set(denials ?? []);
  if ((grants ?? []).some((item) => denied.has(item))) {
    return fail("validation", "A capability cannot be both granted and denied.");
  }
  return ok({
    grants: [...new Set(grants ?? [])] as PortalCapability[],
    denials: [...new Set(denials ?? [])] as PortalCapability[],
  });
}

export interface AgencyUserAccessInput {
  userId: string;
  role: AgencyPortalRole;
  isActive?: boolean;
  capabilityGrants?: string[];
  capabilityDenials?: string[];
}

export interface AgencyUserAccessRecord {
  userId: string;
  displayName: string;
  email: string;
  role: AgencyPortalRole;
  isActive: boolean;
  capabilityGrants: PortalCapability[];
  capabilityDenials: PortalCapability[];
  updatedAt: string;
}

export async function listAgencyUserAccess(
  pool: PgLikePool,
  agencyId: string,
): Promise<AgencyUserAccessRecord[]> {
  if (!UUID.test(agencyId)) return [];
  const { rows } = await pool.query<{
    user_id: string;
    display_name: string;
    email: string;
    portal_role: string;
    is_active: boolean;
    capability_grants: string[];
    capability_denials: string[];
    updated_at: string;
  }>(
    `SELECT uaa.user_id, u.display_name, u.email, uaa.portal_role, uaa.is_active,
            uaa.capability_grants, uaa.capability_denials, uaa.updated_at::text AS updated_at
       FROM user_agency_access uaa
       JOIN users u ON u.id = uaa.user_id
      WHERE uaa.agency_id = $1
      ORDER BY (uaa.is_active = false), u.display_name, uaa.portal_role`,
    [agencyId],
  );
  return rows.flatMap((row) => {
    if (!isAgencyPortalRole(row.portal_role)) return [];
    return [{
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
      role: row.portal_role,
      isActive: row.is_active,
      capabilityGrants: row.capability_grants.filter(isPortalCapability),
      capabilityDenials: row.capability_denials.filter(isPortalCapability),
      updatedAt: row.updated_at,
    }];
  });
}

export async function setAgencyUserAccess(
  pool: PgLikePool,
  agencyId: string,
  input: AgencyUserAccessInput,
  actorId: string,
  reason?: string | null,
): Promise<Result<{ agencyId: string; userId: string; role: AgencyPortalRole; isActive: boolean }>> {
  if (!UUID.test(agencyId) || !UUID.test(input.userId)) return fail("validation", "Choose a valid agency and user.");
  if (!isAgencyPortalRole(input.role)) return fail("validation", "Choose a valid agency portal role.");
  return inTransaction(pool, async (client) => {
    const [agency, user, current] = await Promise.all([
      client.query(`SELECT id FROM agencies WHERE id = $1`, [agencyId]),
      client.query(`SELECT id FROM users WHERE id = $1 AND is_active = true`, [input.userId]),
      client.query<{ capability_grants: string[]; capability_denials: string[] }>(
        `SELECT capability_grants, capability_denials
           FROM user_agency_access
          WHERE user_id = $1 AND agency_id = $2 AND portal_role = $3
          FOR UPDATE`,
        [input.userId, agencyId, input.role],
      ),
    ]);
    if (!agency.rows[0]) return fail("not_found", "That agency no longer exists.");
    if (!user.rows[0]) return fail("not_found", "That active user no longer exists.");
    const configuredPolicy = capabilityPolicy(
      input.role,
      input.capabilityGrants ?? current.rows[0]?.capability_grants,
      input.capabilityDenials ?? current.rows[0]?.capability_denials,
    );
    if (!configuredPolicy.ok) return configuredPolicy;
    const isActive = input.isActive ?? true;
    await client.query(
      `INSERT INTO user_agency_access
         (user_id, agency_id, portal_role, is_active, capability_grants, capability_denials,
          created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7, $7)
       ON CONFLICT (user_id, agency_id, portal_role) DO UPDATE SET
         is_active = EXCLUDED.is_active,
         capability_grants = EXCLUDED.capability_grants,
         capability_denials = EXCLUDED.capability_denials,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = now()`,
      [input.userId, agencyId, input.role, isActive, configuredPolicy.data.grants,
        configuredPolicy.data.denials, actorId],
    );
    await recordChange(client, {
      actorId,
      action: "agency_user_access_set",
      entityType: "agency",
      entityId: agencyId,
      next: { userId: input.userId, role: input.role, isActive, ...configuredPolicy.data },
      reason,
    });
    return ok({ agencyId, userId: input.userId, role: input.role, isActive });
  });
}

export interface AgencyIndividualMembershipInput {
  membershipId?: string;
  individualId: string;
  managesBudget: boolean;
  billsServices: boolean;
  isActive?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

export interface AgencyIndividualMembershipRecord {
  membershipId: string;
  individualId: string;
  individualName: string;
  managesBudget: boolean;
  billsServices: boolean;
  isActive: boolean;
  currentlyEffective: boolean;
  intervalStatus: "current" | "scheduled" | "ended" | "voided";
  isLatest: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface AgencyEmployeeMembershipRecord {
  membershipId: string;
  employeeId: string;
  employeeName: string;
  isActive: boolean;
  currentlyEffective: boolean;
  intervalStatus: "current" | "scheduled" | "ended" | "voided";
  isLatest: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export async function listAgencyIndividualMemberships(
  pool: PgLikePool,
  agencyId: string,
): Promise<AgencyIndividualMembershipRecord[]> {
  if (!UUID.test(agencyId)) return [];
  const { rows } = await pool.query<{
    membership_id: string;
    individual_id: string;
    individual_name: string;
    manages_budget: boolean;
    bills_services: boolean;
    is_active: boolean;
    currently_effective: boolean;
    interval_status: "current" | "scheduled" | "ended" | "voided";
    is_latest: boolean;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT membership.id AS membership_id, membership.individual_id,
            person.display_name AS individual_name,
            membership.manages_budget, membership.bills_services, membership.is_active,
            (membership.is_active
              AND membership.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
              AND (membership.effective_to IS NULL
                OR membership.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)) AS currently_effective,
            CASE
              WHEN membership.is_active = false THEN 'voided'
              WHEN membership.effective_from > (now() AT TIME ZONE 'America/New_York')::date THEN 'scheduled'
              WHEN membership.effective_to < (now() AT TIME ZONE 'America/New_York')::date THEN 'ended'
              ELSE 'current'
            END AS interval_status,
            row_number() OVER (
              PARTITION BY membership.individual_id
              ORDER BY membership.is_active DESC, membership.effective_from DESC,
                       membership.created_at DESC, membership.id DESC
            ) = 1 AS is_latest,
            to_char(membership.effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(membership.effective_to, 'YYYY-MM-DD') AS effective_to
       FROM agency_individuals membership
       JOIN individuals person ON person.id = membership.individual_id
      WHERE membership.agency_id = $1
      ORDER BY person.display_name, membership.effective_from DESC, membership.created_at DESC`,
    [agencyId],
  );
  return rows.map((row) => ({
    membershipId: row.membership_id,
    individualId: row.individual_id,
    individualName: row.individual_name,
    managesBudget: row.manages_budget,
    billsServices: row.bills_services,
    isActive: row.is_active,
    currentlyEffective: row.currently_effective,
    intervalStatus: row.interval_status,
    isLatest: row.is_latest,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  }));
}

export async function listAgencyEmployeeMemberships(
  pool: PgLikePool,
  agencyId: string,
): Promise<AgencyEmployeeMembershipRecord[]> {
  if (!UUID.test(agencyId)) return [];
  const { rows } = await pool.query<{
    membership_id: string;
    employee_id: string;
    employee_name: string;
    is_active: boolean;
    currently_effective: boolean;
    interval_status: "current" | "scheduled" | "ended" | "voided";
    is_latest: boolean;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT membership.id AS membership_id, membership.employee_id,
            person.display_name AS employee_name,
            membership.is_active,
            (membership.is_active
              AND membership.effective_from <= (now() AT TIME ZONE 'America/New_York')::date
              AND (membership.effective_to IS NULL
                OR membership.effective_to >= (now() AT TIME ZONE 'America/New_York')::date)) AS currently_effective,
            CASE
              WHEN membership.is_active = false THEN 'voided'
              WHEN membership.effective_from > (now() AT TIME ZONE 'America/New_York')::date THEN 'scheduled'
              WHEN membership.effective_to < (now() AT TIME ZONE 'America/New_York')::date THEN 'ended'
              ELSE 'current'
            END AS interval_status,
            row_number() OVER (
              PARTITION BY membership.employee_id
              ORDER BY membership.is_active DESC, membership.effective_from DESC,
                       membership.created_at DESC, membership.id DESC
            ) = 1 AS is_latest,
            to_char(membership.effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(membership.effective_to, 'YYYY-MM-DD') AS effective_to
       FROM agency_employees membership
       JOIN employees person ON person.id = membership.employee_id
      WHERE membership.agency_id = $1
      ORDER BY person.display_name, membership.effective_from DESC, membership.created_at DESC`,
    [agencyId],
  );
  return rows.map((row) => ({
    membershipId: row.membership_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    isActive: row.is_active,
    currentlyEffective: row.currently_effective,
    intervalStatus: row.interval_status,
    isLatest: row.is_latest,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  }));
}

function validDate(value: string | null | undefined): boolean {
  return value == null || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

interface IndividualMembershipIntervalRow {
  id: string;
  manages_budget: boolean;
  bills_services: boolean;
  effective_from: string;
  effective_to: string | null;
}

interface EmployeeMembershipIntervalRow {
  id: string;
  effective_from: string;
  effective_to: string | null;
}

function isMembershipOverlap(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23P01";
}

async function acquireMembershipTimelineLock(
  client: PgLikeClient,
  kind: "individual" | "employee",
  agencyId: string,
  personId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`agency_${kind === "individual" ? "individuals" : "employees"}:${agencyId}:${personId}`],
  );
}

export async function setAgencyIndividualMembership(
  pool: PgLikePool,
  agencyId: string,
  input: AgencyIndividualMembershipInput,
  actorId: string,
  reason?: string | null,
): Promise<Result<{ agencyId: string; individualId: string }>> {
  if (!UUID.test(agencyId) || !UUID.test(input.individualId)) return fail("validation", "Choose a valid agency and individual.");
  if (input.membershipId && !UUID.test(input.membershipId)) return fail("validation", "Choose a valid membership interval.");
  if (!input.managesBudget && !input.billsServices) return fail("validation", "Choose budget management, billing, or both.");
  if (!validDate(input.effectiveFrom) || !validDate(input.effectiveTo)) return fail("validation", "Use YYYY-MM-DD for effective dates.");
  if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    return fail("validation", "The end date cannot be before the start date.");
  }
  try {
    return await inTransaction(pool, async (client) => {
      await acquireMembershipTimelineLock(client, "individual", agencyId, input.individualId);
      const related = await client.query(
        `SELECT EXISTS (SELECT 1 FROM agencies WHERE id = $1) AS agency_exists,
                EXISTS (SELECT 1 FROM individuals WHERE id = $2) AS person_exists`,
        [agencyId, input.individualId],
      );
      const row = related.rows[0] as { agency_exists?: boolean; person_exists?: boolean } | undefined;
      if (!row?.agency_exists || !row.person_exists) return fail("not_found", "That agency or individual no longer exists.");

      const currentResult = await client.query<IndividualMembershipIntervalRow>(
        `SELECT id, manages_budget, bills_services,
                to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                to_char(effective_to, 'YYYY-MM-DD') AS effective_to
           FROM agency_individuals
          WHERE agency_id = $1 AND individual_id = $2 AND is_active = true
            AND effective_from <= (now() AT TIME ZONE 'America/New_York')::date
            AND (effective_to IS NULL
              OR effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
          ORDER BY effective_from DESC, created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [agencyId, input.individualId],
      );
      const current = currentResult.rows[0];

      if (input.isActive === false) {
        if (input.membershipId && current?.id !== input.membershipId) {
          const cancelled = await client.query<IndividualMembershipIntervalRow>(
            `UPDATE agency_individuals
                SET is_active = false, updated_by_user_id = $4, updated_at = now()
              WHERE id = $1 AND agency_id = $2 AND individual_id = $3 AND is_active = true
                AND effective_from > (now() AT TIME ZONE 'America/New_York')::date
            RETURNING id, manages_budget, bills_services,
                      to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                      to_char(effective_to, 'YYYY-MM-DD') AS effective_to`,
            [input.membershipId, agencyId, input.individualId, actorId],
          );
          if (!cancelled.rows[0]) {
            return fail("immutable", "Only a future membership interval can be cancelled. Historical intervals are retained.");
          }
          await recordChange(client, {
            actorId,
            action: "agency_individual_membership_cancelled",
            entityType: "individual",
            entityId: input.individualId,
            previous: { agencyId, ...cancelled.rows[0], isActive: true },
            next: { agencyId, membershipId: input.membershipId, isActive: false },
            reason,
          });
          return ok({ agencyId, individualId: input.individualId });
        }
        if (!current) return fail("not_found", "There is no current membership interval to end.");
        const closeOn = input.effectiveTo ?? null;
        if (closeOn && closeOn < current.effective_from) {
          return fail("validation", "The end date cannot be before the current interval began.");
        }
        const closed = await client.query<{ effective_to: string }>(
          `UPDATE agency_individuals
              SET effective_to = LEAST(COALESCE(effective_to, COALESCE(
                                         $2::date, (now() AT TIME ZONE 'America/New_York')::date)),
                                       COALESCE($2::date, (now() AT TIME ZONE 'America/New_York')::date)),
                  updated_by_user_id = $3,
                  updated_at = now()
            WHERE id = $1 AND is_active = true
          RETURNING to_char(effective_to, 'YYYY-MM-DD') AS effective_to`,
          [current.id, closeOn, actorId],
        );
        await recordChange(client, {
          actorId,
          action: "agency_individual_membership_ended",
          entityType: "individual",
          entityId: input.individualId,
          previous: { agencyId, ...current },
          next: { agencyId, membershipId: current.id, effectiveTo: closed.rows[0]?.effective_to },
          reason,
        });
        return ok({ agencyId, individualId: input.individualId });
      }

      if (current) {
        if (!input.effectiveFrom) {
          return fail("validation", "Choose the date when the new membership terms begin.");
        }
        if (input.effectiveFrom <= current.effective_from) {
          return fail("conflict", "New membership terms must begin after the current interval began.");
        }
        await client.query(
          `UPDATE agency_individuals
              SET effective_to = ($2::date - 1), updated_by_user_id = $3, updated_at = now()
            WHERE id = $1 AND is_active = true
              AND (effective_to IS NULL OR effective_to >= $2::date)`,
          [current.id, input.effectiveFrom, actorId],
        );
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO agency_individuals
         (agency_id, individual_id, manages_budget, bills_services, is_active,
          effective_from, effective_to, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, true,
               COALESCE($5::date, (now() AT TIME ZONE 'America/New_York')::date),
               $6::date, $7, $7)
       RETURNING id`,
        [agencyId, input.individualId, input.managesBudget, input.billsServices,
          input.effectiveFrom ?? null, input.effectiveTo ?? null, actorId],
      );
      await recordChange(client, {
        actorId,
        action: current ? "agency_individual_membership_changed" : "agency_individual_membership_started",
        entityType: "individual",
        entityId: input.individualId,
        previous: current ? { agencyId, ...current } : undefined,
        next: { agencyId, membershipId: inserted.rows[0]?.id, ...input, isActive: true },
        reason,
      });
      return ok({ agencyId, individualId: input.individualId });
    });
  } catch (error) {
    if (isMembershipOverlap(error)) {
      return fail("conflict", "That membership period overlaps existing history. Choose dates outside the existing intervals.");
    }
    throw error;
  }
}

export async function setAgencyEmployeeMembership(
  pool: PgLikePool,
  agencyId: string,
  input: { membershipId?: string; employeeId: string; isActive?: boolean; effectiveFrom?: string; effectiveTo?: string | null },
  actorId: string,
  reason?: string | null,
): Promise<Result<{ agencyId: string; employeeId: string }>> {
  if (!UUID.test(agencyId) || !UUID.test(input.employeeId)) return fail("validation", "Choose a valid agency and employee.");
  if (input.membershipId && !UUID.test(input.membershipId)) return fail("validation", "Choose a valid membership interval.");
  if (!validDate(input.effectiveFrom) || !validDate(input.effectiveTo)) return fail("validation", "Use YYYY-MM-DD for effective dates.");
  if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    return fail("validation", "The end date cannot be before the start date.");
  }
  try {
    return await inTransaction(pool, async (client) => {
      await acquireMembershipTimelineLock(client, "employee", agencyId, input.employeeId);
      const related = await client.query(
        `SELECT EXISTS (SELECT 1 FROM agencies WHERE id = $1) AS agency_exists,
                EXISTS (SELECT 1 FROM employees WHERE id = $2) AS person_exists`,
        [agencyId, input.employeeId],
      );
      const row = related.rows[0] as { agency_exists?: boolean; person_exists?: boolean } | undefined;
      if (!row?.agency_exists || !row.person_exists) return fail("not_found", "That agency or employee no longer exists.");

      const currentResult = await client.query<EmployeeMembershipIntervalRow>(
        `SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                to_char(effective_to, 'YYYY-MM-DD') AS effective_to
           FROM agency_employees
          WHERE agency_id = $1 AND employee_id = $2 AND is_active = true
            AND effective_from <= (now() AT TIME ZONE 'America/New_York')::date
            AND (effective_to IS NULL
              OR effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
          ORDER BY effective_from DESC, created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [agencyId, input.employeeId],
      );
      const current = currentResult.rows[0];

      if (input.isActive === false) {
        if (input.membershipId && current?.id !== input.membershipId) {
          const cancelled = await client.query<EmployeeMembershipIntervalRow>(
            `UPDATE agency_employees
                SET is_active = false, updated_by_user_id = $4, updated_at = now()
              WHERE id = $1 AND agency_id = $2 AND employee_id = $3 AND is_active = true
                AND effective_from > (now() AT TIME ZONE 'America/New_York')::date
            RETURNING id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                      to_char(effective_to, 'YYYY-MM-DD') AS effective_to`,
            [input.membershipId, agencyId, input.employeeId, actorId],
          );
          if (!cancelled.rows[0]) {
            return fail("immutable", "Only a future membership interval can be cancelled. Historical intervals are retained.");
          }
          await recordChange(client, {
            actorId,
            action: "agency_employee_membership_cancelled",
            entityType: "employee",
            entityId: input.employeeId,
            previous: { agencyId, ...cancelled.rows[0], isActive: true },
            next: { agencyId, membershipId: input.membershipId, isActive: false },
            reason,
          });
          return ok({ agencyId, employeeId: input.employeeId });
        }
        if (!current) return fail("not_found", "There is no current membership interval to end.");
        const closeOn = input.effectiveTo ?? null;
        if (closeOn && closeOn < current.effective_from) {
          return fail("validation", "The end date cannot be before the current interval began.");
        }
        const closed = await client.query<{ effective_to: string }>(
          `UPDATE agency_employees
              SET effective_to = LEAST(COALESCE(effective_to, COALESCE(
                                         $2::date, (now() AT TIME ZONE 'America/New_York')::date)),
                                       COALESCE($2::date, (now() AT TIME ZONE 'America/New_York')::date)),
                  updated_by_user_id = $3,
                  updated_at = now()
            WHERE id = $1 AND is_active = true
          RETURNING to_char(effective_to, 'YYYY-MM-DD') AS effective_to`,
          [current.id, closeOn, actorId],
        );
        await recordChange(client, {
          actorId,
          action: "agency_employee_membership_ended",
          entityType: "employee",
          entityId: input.employeeId,
          previous: { agencyId, ...current },
          next: { agencyId, membershipId: current.id, effectiveTo: closed.rows[0]?.effective_to },
          reason,
        });
        return ok({ agencyId, employeeId: input.employeeId });
      }

      if (current) {
        if (!input.effectiveFrom) {
          return fail("validation", "Choose the date when the new membership interval begins.");
        }
        if (input.effectiveFrom <= current.effective_from) {
          return fail("conflict", "The new membership interval must begin after the current interval began.");
        }
        await client.query(
          `UPDATE agency_employees
              SET effective_to = ($2::date - 1), updated_by_user_id = $3, updated_at = now()
            WHERE id = $1 AND is_active = true
              AND (effective_to IS NULL OR effective_to >= $2::date)`,
          [current.id, input.effectiveFrom, actorId],
        );
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO agency_employees
         (agency_id, employee_id, is_active, effective_from, effective_to,
          created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, true,
               COALESCE($3::date, (now() AT TIME ZONE 'America/New_York')::date),
               $4::date, $5, $5)
       RETURNING id`,
        [agencyId, input.employeeId, input.effectiveFrom ?? null, input.effectiveTo ?? null, actorId],
      );
      await recordChange(client, {
        actorId,
        action: current ? "agency_employee_membership_changed" : "agency_employee_membership_started",
        entityType: "employee",
        entityId: input.employeeId,
        previous: current ? { agencyId, ...current } : undefined,
        next: { agencyId, membershipId: inserted.rows[0]?.id, ...input, isActive: true },
        reason,
      });
      return ok({ agencyId, employeeId: input.employeeId });
    });
  } catch (error) {
    if (isMembershipOverlap(error)) {
      return fail("conflict", "That membership period overlaps existing history. Choose dates outside the existing intervals.");
    }
    throw error;
  }
}
