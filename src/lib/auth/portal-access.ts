import type { PgLikePool } from "@/lib/import/commit";

export const GLOBAL_PORTAL_ROLES = ["owner", "individual", "parent", "employee"] as const;
export const AGENCY_PORTAL_ROLES = ["agency", "staffing_manager", "scheduler", "collector"] as const;
export const PORTAL_ROLES = [...GLOBAL_PORTAL_ROLES, ...AGENCY_PORTAL_ROLES] as const;

export type GlobalPortalRole = (typeof GLOBAL_PORTAL_ROLES)[number];
export type AgencyPortalRole = (typeof AGENCY_PORTAL_ROLES)[number];
export type PortalRole = (typeof PORTAL_ROLES)[number];

export const PORTAL_CAPABILITIES = [
  "agencies.read",
  "agencies.manage",
  "users.manage",
  "people.self.read",
  "people.agency.read",
  "people.agency.manage",
  "assignments.self.read",
  "assignments.agency.manage",
  "schedules.self.read",
  "schedules.agency.read",
  "schedules.agency.manage",
  "hours_budgets.self.read",
  "hours_budgets.agency.read",
  "hours_budgets.agency.manage",
  "dollar_budgets.self.read",
  "dollar_budgets.agency.read",
  "transactions.self.read",
  "transactions.agency.read",
  "employee_pay.self.read",
  "employee_checks.self.gross.read",
  "employee_checks.self.net.read",
  "employee_checks.self.tax.read",
  "employee_giveback.self.read",
  "financials.self.billed_totals.read",
  "financials.self.cuts_set_asides.read",
  "financials.self.direct_checks.read",
  "financials.self.agency_paid.read",
  "financials.agency.billed_totals.read",
  "financials.agency.cuts_set_asides.read",
  "financials.agency.direct_checks.read",
  "financials.agency.agency_paid.read",
  "settlements.agency.read",
  "settlements.agency.manage",
  "documents.self.read",
] as const;

export type PortalCapability = (typeof PORTAL_CAPABILITIES)[number];
export type IndividualRelationship = "self" | "parent" | "guardian" | "representative";
export type EmployeeRelationship = "self";

const INDIVIDUAL_SELF_CAPABILITIES = new Set<PortalCapability>([
  "people.self.read",
  "hours_budgets.self.read",
  "dollar_budgets.self.read",
  "financials.self.billed_totals.read",
  "financials.self.cuts_set_asides.read",
  "financials.self.direct_checks.read",
  "financials.self.agency_paid.read",
]);

const EMPLOYEE_SELF_CAPABILITIES = new Set<PortalCapability>([
  "people.self.read",
  "employee_checks.self.gross.read",
  "employee_checks.self.net.read",
  "employee_checks.self.tax.read",
  "employee_giveback.self.read",
]);

const AGENCY_READ_CAPABILITIES = new Set<PortalCapability>([
  "agencies.read",
  "people.agency.read",
  "hours_budgets.agency.read",
  "dollar_budgets.agency.read",
  "financials.agency.billed_totals.read",
  "financials.agency.cuts_set_asides.read",
  "financials.agency.direct_checks.read",
  "financials.agency.agency_paid.read",
  "settlements.agency.read",
]);

const ROLE_CAPABILITIES: Record<PortalRole, readonly PortalCapability[]> = {
  owner: PORTAL_CAPABILITIES,
  individual: [
    "people.self.read",
    "hours_budgets.self.read",
  ],
  parent: [
    "people.self.read",
    "hours_budgets.self.read",
  ],
  employee: [
    "people.self.read",
    "employee_checks.self.gross.read",
    "employee_checks.self.net.read",
    "employee_checks.self.tax.read",
    "employee_giveback.self.read",
  ],
  agency: [
    "agencies.read",
    "people.agency.read",
    "hours_budgets.agency.read",
    "dollar_budgets.agency.read",
    "financials.agency.billed_totals.read",
    "financials.agency.cuts_set_asides.read",
    "financials.agency.direct_checks.read",
    "financials.agency.agency_paid.read",
    "settlements.agency.read",
  ],
  staffing_manager: [
    "agencies.read",
    "people.agency.read",
    "hours_budgets.agency.read",
    "assignments.agency.manage",
    "schedules.agency.read",
    "schedules.agency.manage",
  ],
  scheduler: [
    "agencies.read",
    "people.agency.read",
    "hours_budgets.agency.read",
    "schedules.agency.read",
    "schedules.agency.manage",
  ],
  collector: [
    "agencies.read",
    "people.agency.read",
    "financials.agency.cuts_set_asides.read",
    "financials.agency.direct_checks.read",
    "financials.agency.agency_paid.read",
    "settlements.agency.read",
  ],
};

export interface CapabilityPolicy {
  grants: PortalCapability[];
  denials: PortalCapability[];
}

export interface GlobalRoleAccess extends CapabilityPolicy {
  role: GlobalPortalRole;
}

export interface AgencyRoleAccess extends CapabilityPolicy {
  agencyId: string;
  agencyCode: string;
  agencyName: string;
  role: AgencyPortalRole;
}

export interface IndividualPortalLink extends CapabilityPolicy {
  individualId: string;
  relationship: IndividualRelationship;
}

export interface EmployeePortalLink extends CapabilityPolicy {
  employeeId: string;
  relationship: EmployeeRelationship;
}

export interface PortalAccessContext {
  userId: string;
  globalRoles: GlobalRoleAccess[];
  agencyAccess: AgencyRoleAccess[];
  individualLinks: IndividualPortalLink[];
  employeeLinks: EmployeePortalLink[];
}

interface GlobalRoleRow {
  portal_role: string;
  capability_grants: string[];
  capability_denials: string[];
}

interface AgencyRoleRow extends GlobalRoleRow {
  agency_id: string;
  agency_code: string;
  agency_name: string;
}

interface IndividualLinkRow {
  individual_id: string;
  relationship_type: string;
  capability_grants: string[];
  capability_denials: string[];
}

interface EmployeeLinkRow {
  employee_id: string;
  relationship_type: string;
  capability_grants: string[];
  capability_denials: string[];
}

const CAPABILITY_SET = new Set<string>(PORTAL_CAPABILITIES);

export function isPortalCapability(value: string): value is PortalCapability {
  return CAPABILITY_SET.has(value);
}

export function isGlobalPortalRole(value: string): value is GlobalPortalRole {
  return (GLOBAL_PORTAL_ROLES as readonly string[]).includes(value);
}

export function isAgencyPortalRole(value: string): value is AgencyPortalRole {
  return (AGENCY_PORTAL_ROLES as readonly string[]).includes(value);
}

export function portalCapabilitiesForRole(role: PortalRole): readonly PortalCapability[] {
  return ROLE_CAPABILITIES[role];
}

function policy(
  grants: readonly string[] | null | undefined,
  denials: readonly string[] | null | undefined,
  allowed: ReadonlySet<PortalCapability>,
): CapabilityPolicy {
  const normalize = (items: readonly string[] | null | undefined) =>
    [...new Set((items ?? []).filter((item): item is PortalCapability => isPortalCapability(item) && allowed.has(item)))];
  return { grants: normalize(grants), denials: normalize(denials) };
}

function allowedForGlobalRole(role: GlobalPortalRole): ReadonlySet<PortalCapability> {
  if (role === "owner") return new Set(PORTAL_CAPABILITIES);
  if (role === "employee") return EMPLOYEE_SELF_CAPABILITIES;
  return INDIVIDUAL_SELF_CAPABILITIES;
}

function allowedForAgencyRole(role: AgencyPortalRole): ReadonlySet<PortalCapability> {
  if (role === "agency") return AGENCY_READ_CAPABILITIES;
  if (role === "collector") {
    return new Set<PortalCapability>([
      ...ROLE_CAPABILITIES.collector,
      "financials.agency.billed_totals.read",
    ]);
  }
  // Staffing and scheduler roles are categorically hours-only. Their schedule
  // writes are checked again against the agency roster at every endpoint. A
  // per-account override may narrow them, but can never add money access.
  return new Set(ROLE_CAPABILITIES[role]);
}

export function agencyIdsWithPortalCapability(
  context: PortalAccessContext,
  capability: PortalCapability,
): string[] {
  return [...new Set(
    context.agencyAccess
      .filter((assignment) => hasPortalCapability(context, capability, assignment.agencyId))
      .map((assignment) => assignment.agencyId),
  )];
}

/** Planning always exposes authorization hours, so both read grants are required. */
export function agencyIdsWithPlanningAccess(context: PortalAccessContext): string[] {
  return agencyIdsWithPortalCapability(context, "schedules.agency.read").filter((agencyId) =>
    hasPortalCapability(context, "hours_budgets.agency.read", agencyId));
}

export function portalCapabilityAllowedForRole(
  role: PortalRole,
  capability: PortalCapability,
): boolean {
  if (role === "owner") return true;
  if (isAgencyPortalRole(role)) return allowedForAgencyRole(role).has(capability);
  return allowedForGlobalRole(role).has(capability);
}

function effectiveCapabilities(
  roles: readonly { role: PortalRole; grants: readonly PortalCapability[]; denials: readonly PortalCapability[] }[],
  extraPolicies: readonly CapabilityPolicy[] = [],
): PortalCapability[] {
  const granted = new Set<PortalCapability>();
  const denied = new Set<PortalCapability>();
  for (const assignment of roles) {
    for (const capability of ROLE_CAPABILITIES[assignment.role]) granted.add(capability);
    for (const capability of assignment.grants) granted.add(capability);
    for (const capability of assignment.denials) denied.add(capability);
  }
  for (const item of extraPolicies) {
    for (const capability of item.grants) granted.add(capability);
    for (const capability of item.denials) denied.add(capability);
  }
  return PORTAL_CAPABILITIES.filter((capability) => granted.has(capability) && !denied.has(capability));
}

export async function resolvePortalAccess(
  pool: PgLikePool,
  user: { id: string },
): Promise<PortalAccessContext> {
  const [globalResult, agencyResult, individualResult, employeeResult] = await Promise.all([
    pool.query<GlobalRoleRow>(
      `SELECT portal_role, capability_grants, capability_denials
         FROM user_portal_roles
        WHERE user_id = $1 AND is_active = true`,
      [user.id],
    ),
    pool.query<AgencyRoleRow>(
      `SELECT uaa.portal_role, uaa.capability_grants, uaa.capability_denials,
              a.id AS agency_id, a.code AS agency_code, a.name AS agency_name
         FROM user_agency_access uaa
         JOIN agencies a ON a.id = uaa.agency_id
        WHERE uaa.user_id = $1 AND uaa.is_active = true AND a.status = 'active'`,
      [user.id],
    ),
    pool.query<IndividualLinkRow>(
      `SELECT individual_id, relationship_type, capability_grants, capability_denials
         FROM user_individual_relationships
        WHERE user_id = $1 AND is_active = true`,
      [user.id],
    ),
    pool.query<EmployeeLinkRow>(
      `SELECT employee_id, relationship_type, capability_grants, capability_denials
         FROM user_employee_relationships
        WHERE user_id = $1 AND is_active = true`,
      [user.id],
    ),
  ]);

  const globalRoles: GlobalRoleAccess[] = globalResult.rows.flatMap((row) => {
    if (!isGlobalPortalRole(row.portal_role)) return [];
    return [{ role: row.portal_role, ...policy(row.capability_grants, row.capability_denials, allowedForGlobalRole(row.portal_role)) }];
  });
  const agencyAccess: AgencyRoleAccess[] = agencyResult.rows.flatMap((row) => {
    if (!isAgencyPortalRole(row.portal_role)) return [];
    return [{
      agencyId: row.agency_id,
      agencyCode: row.agency_code,
      agencyName: row.agency_name,
      role: row.portal_role,
      ...policy(row.capability_grants, row.capability_denials, allowedForAgencyRole(row.portal_role)),
    }];
  });
  const individualLinks: IndividualPortalLink[] = individualResult.rows.flatMap((row) => {
    if (!["self", "parent", "guardian", "representative"].includes(row.relationship_type)) return [];
    return [{
      individualId: row.individual_id,
      relationship: row.relationship_type as IndividualRelationship,
      ...policy(row.capability_grants, row.capability_denials, INDIVIDUAL_SELF_CAPABILITIES),
    }];
  });
  const employeeLinks: EmployeePortalLink[] = employeeResult.rows.flatMap((row) => {
    if (row.relationship_type !== "self") return [];
    return [{
      employeeId: row.employee_id,
      relationship: "self" as const,
      ...policy(row.capability_grants, row.capability_denials, EMPLOYEE_SELF_CAPABILITIES),
    }];
  });

  return { userId: user.id, globalRoles, agencyAccess, individualLinks, employeeLinks };
}

export function isPortalOwner(context: PortalAccessContext): boolean {
  return context.globalRoles.some((assignment) => assignment.role === "owner");
}

export function portalCapabilities(
  context: PortalAccessContext,
  agencyId?: string,
): PortalCapability[] {
  if (isPortalOwner(context)) {
    const ownerAssignments = context.globalRoles.filter((assignment) => assignment.role === "owner");
    return effectiveCapabilities(ownerAssignments);
  }
  if (agencyId) {
    return effectiveCapabilities(context.agencyAccess.filter((assignment) => assignment.agencyId === agencyId));
  }
  return effectiveCapabilities(context.globalRoles);
}

export function hasPortalCapability(
  context: PortalAccessContext,
  capability: PortalCapability,
  agencyId?: string,
): boolean {
  return portalCapabilities(context, agencyId).includes(capability);
}

function individualRoleFor(relationship: IndividualRelationship): GlobalPortalRole {
  return relationship === "self" ? "individual" : "parent";
}

export function portalIndividualCapabilities(
  context: PortalAccessContext,
  individualId: string,
): PortalCapability[] {
  if (isPortalOwner(context)) return portalCapabilities(context);
  const links = context.individualLinks.filter((link) => link.individualId === individualId);
  const roles = context.globalRoles.filter((assignment) =>
    links.some((link) => assignment.role === individualRoleFor(link.relationship)),
  );
  const applicableLinks = links.filter((link) =>
    roles.some((assignment) => assignment.role === individualRoleFor(link.relationship)),
  );
  return effectiveCapabilities(roles, applicableLinks);
}

export function portalEmployeeCapabilities(
  context: PortalAccessContext,
  employeeId: string,
): PortalCapability[] {
  if (isPortalOwner(context)) return portalCapabilities(context);
  const roles = context.globalRoles.filter((assignment) => assignment.role === "employee");
  const links = context.employeeLinks.filter((link) => link.employeeId === employeeId);
  return links.length > 0 ? effectiveCapabilities(roles, links) : [];
}

export function hasPortalIndividualCapability(
  context: PortalAccessContext,
  individualId: string,
  capability: PortalCapability,
): boolean {
  return portalIndividualCapabilities(context, individualId).includes(capability);
}

export function hasPortalEmployeeCapability(
  context: PortalAccessContext,
  employeeId: string,
  capability: PortalCapability,
): boolean {
  return portalEmployeeCapabilities(context, employeeId).includes(capability);
}

export function canAccessPortalAgency(
  context: PortalAccessContext,
  agencyId: string,
  capability: PortalCapability = "agencies.read",
): boolean {
  return hasPortalCapability(context, capability, agencyId);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function canAccessPortalIndividual(
  pool: PgLikePool,
  context: PortalAccessContext,
  individualId: string,
): Promise<boolean> {
  if (!UUID.test(individualId)) return false;
  if (hasPortalIndividualCapability(context, individualId, "people.self.read")) return true;
  if (isPortalOwner(context)) return hasPortalCapability(context, "people.agency.read");
  const agencyIds = agencyIdsWithPortalCapability(context, "people.agency.read");
  if (agencyIds.length === 0) return false;
  const { rows } = await pool.query<{ allowed: boolean }>(
    `SELECT true AS allowed
       FROM agency_individuals
      WHERE individual_id = $1
        AND agency_id = ANY($2::uuid[])
        AND is_active = true
        AND effective_from <= (now() AT TIME ZONE 'America/New_York')::date
        AND (effective_to IS NULL
          OR effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
      LIMIT 1`,
    [individualId, agencyIds],
  );
  return rows[0]?.allowed === true;
}

export async function canAccessPortalEmployee(
  pool: PgLikePool,
  context: PortalAccessContext,
  employeeId: string,
): Promise<boolean> {
  if (!UUID.test(employeeId)) return false;
  if (hasPortalEmployeeCapability(context, employeeId, "people.self.read")) return true;
  if (isPortalOwner(context)) return hasPortalCapability(context, "people.agency.read");
  const agencyIds = agencyIdsWithPortalCapability(context, "people.agency.read");
  if (agencyIds.length === 0) return false;
  const { rows } = await pool.query<{ allowed: boolean }>(
    `SELECT true AS allowed
       FROM agency_employees
      WHERE employee_id = $1
        AND agency_id = ANY($2::uuid[])
        AND is_active = true
        AND effective_from <= (now() AT TIME ZONE 'America/New_York')::date
        AND (effective_to IS NULL
          OR effective_to >= (now() AT TIME ZONE 'America/New_York')::date)
      LIMIT 1`,
    [employeeId, agencyIds],
  );
  return rows[0]?.allowed === true;
}

export const PORTAL_ROLE_LABELS: Record<PortalRole, string> = {
  owner: "Owner",
  individual: "Individual",
  parent: "Parent or guardian",
  employee: "Employee",
  agency: "Agency overview",
  staffing_manager: "Agency staffing summary",
  scheduler: "Agency hours summary",
  collector: "Agency collection summary",
};
