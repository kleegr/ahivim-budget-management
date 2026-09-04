import {
  ACCOUNT_PRESETS,
  type AccountPresetId,
} from "@/lib/auth/account-presets";
import {
  isPortalOwner,
  portalCapabilities,
  portalEmployeeCapabilities,
  portalIndividualCapabilities,
  type PortalAccessContext,
  type PortalCapability,
} from "@/lib/auth/portal-access";
import type { UserWithAccess } from "@/lib/auth/users";

export interface RolePreviewDetails {
  landingHref: string;
  landingLabel: string;
  visible: string;
  hidden: string;
}

/** Owner-facing explanations for the exact presets used by provisioning. */
export const ROLE_PREVIEW_DETAILS = {
  owner: {
    landingHref: "/dashboard",
    landingLabel: "Owner Home",
    visible: "The full agency roster, programs, budgets, activity, schedules, money, reports, settings, and user administration.",
    hidden: "No agency business area is intentionally hidden; secrets and infrastructure controls remain outside the application UI.",
  },
  office_manager: {
    landingHref: "/dashboard",
    landingLabel: "Agency dashboard",
    visible: "Everyday agency operations, people, schedules, budgets, financial workspaces, imports, and reports.",
    hidden: "User administration, owner-only settings, and infrastructure controls.",
  },
  budget_planner: {
    landingHref: "/home",
    landingLabel: "Budget planning Home",
    visible: "Planning roster, authorized, actual, scheduled, and remaining hours, renewals, pace, assignments, availability, time off, and direct-pay targets as hours.",
    hidden: "Rates, dollars, transactions, payroll checks, gross, net, taxes, deals, Masser, settlements, and agency spread.",
  },
  staffing_manager: {
    landingHref: "/home",
    landingLabel: "Staffing Home",
    visible: "Employees, availability, time off, assignments, and schedules.",
    hidden: "Budgets, rates, transactions, payroll, settlements, and all other financial information.",
  },
  money_collector: {
    landingHref: "/home",
    landingLabel: "Money operations Home",
    visible: "Check confirmation, employee collections, agency payments, individual put-away, credits, corrections, and statements.",
    hidden: "Budget planning, funder revenue, agency spread, and the owner-only final agency result.",
  },
  class_billing: {
    landingHref: "/home",
    landingLabel: "Class billing Home",
    visible: "Class allowances, invoice building, cover sheets, saved class documents, and related document editing.",
    hidden: "Unrelated payroll, Masser, settlements, employee deals, and general budget planning.",
  },
  individual_parent: {
    landingHref: "/portal",
    landingLabel: "Individual portal",
    visible: "The directly linked individual, approved budget and hour information, permitted financial summaries and trends, put-away statement, schedule, and privacy-safe exports.",
    hidden: "Employee identity, employee checks, gross, net, taxes, deals, collections, and every unlinked person.",
  },
  employee: {
    landingHref: "/portal",
    landingLabel: "Employee portal",
    visible: "The linked employee's verified direct checks, permitted gross, net and withholding, direct service history, give-back, payments, credit, balance, and final amount kept.",
    hidden: "Other employees, owner agency results, and agency-routed work presented as direct employee pay.",
  },
  agency: {
    landingHref: "/portal",
    landingLabel: "Agency portal",
    visible: "The dated agency roster, approved individual and employee rollups, permitted hours and financial categories, and scoped check drilldowns.",
    hidden: "Records outside the linked agency, unapproved financial fields, and the agency-wide owner result.",
  },
  agency_scheduler: {
    landingHref: "/schedule",
    landingLabel: "Schedule",
    visible: "Agency-scoped schedules and authorized-hour coverage for the linked roster.",
    hidden: "All money, records outside the linked agency, payroll, settlements, and owner administration.",
  },
  agency_staffing_manager: {
    landingHref: "/schedule",
    landingLabel: "Schedule",
    visible: "The agency employee roster, availability, assignments, and schedules.",
    hidden: "All money, budgets, records outside the linked agency, payroll, settlements, and owner administration.",
  },
  agency_collector: {
    landingHref: "/portal",
    landingLabel: "Agency portal",
    visible: "Read-only approved agency financial, payment, and settlement information for the linked roster.",
    hidden: "The internal global Masser, budget planning, deal editing, records outside the linked agency, and the owner result.",
  },
  custom_access: {
    landingHref: "/home",
    landingLabel: "First permitted workspace",
    visible: "Only the people, workspaces, and actions explicitly selected by the owner during account setup.",
    hidden: "Every internal area and record that was not explicitly granted.",
  },
} as const satisfies Record<AccountPresetId, RolePreviewDetails>;

const ACCESS_KEYS = [
  "accessScope",
  "seeAllIndividuals",
  "seeAllEmployees",
  "canSeeTransactions",
  "canSeeMoney",
  "canSeeHours",
  "canSeeBilledAmounts",
  "canSeeEmployeeAmounts",
  "canSeeAgencySpread",
  "canSeeCheckNet",
  "canSeeTaxes",
  "canSeeBudgets",
  "canSeeEmployeeDeals",
  "canSeeSettlements",
  "canManageSettlements",
  "canSeeClassFinancials",
  "canManageClassInvoices",
  "canEditDocuments",
  "canPlan",
] as const;

function matchesInternalPreset(
  user: UserWithAccess,
  preset: NonNullable<(typeof ACCOUNT_PRESETS)[number]["access"]>,
): boolean {
  if (!ACCESS_KEYS.every((key) => user[key] === preset[key])) return false;
  return user.individualCount === preset.individualIds.length
    && user.employeeCount === preset.employeeIds.length;
}

/**
 * Persisted `accountPreset` is authoritative even when an owner safely adjusts
 * its permissions. Legacy accounts without one are inferred from trusted roles,
 * portal identity, or the exact access shapes used by the Settings editor.
 */
export function previewPresetForUser(user: UserWithAccess): AccountPresetId | null {
  if (user.accountPreset) return user.accountPreset;
  if (user.role === "admin") return "owner";
  if (user.role === "manager") return "office_manager";
  if (user.role !== "viewer" || user.portalManaged) return null;

  for (const preset of ACCOUNT_PRESETS) {
    if (preset.binding.kind !== "none" || !preset.access) continue;
    if (matchesInternalPreset(user, preset.access)) return preset.id;
  }
  return "custom_access";
}

export interface RolePreviewLinkedAgency {
  name: string;
  role: string;
  individualCount: number;
  employeeCount: number;
}

export interface RolePreviewPortalScope {
  key: string;
  label: string;
  /** Capabilities active after preset defaults, grants, and denials are combined. */
  effectiveGrants: string[];
  /** Explicit owner-selected denials that apply to this exact linked scope. */
  effectiveDenials: string[];
}

export interface RolePreviewAccount {
  id: string;
  displayName: string;
  email: string;
  lastLoginAt: string | null;
  isCurrent: boolean;
  seeAllIndividuals: boolean;
  seeAllEmployees: boolean;
  individualAccessCount: number;
  employeeAccessCount: number;
  linkedIndividuals: string[];
  linkedEmployees: string[];
  linkedAgencies: RolePreviewLinkedAgency[];
  /** Effective internal-workspace permissions, resolved from the stored account. */
  effectiveGrants: string[];
  effectiveDenials: string[];
  /** Effective portal permissions, retained per linked subject or agency. */
  portalScopes: RolePreviewPortalScope[];
}

export interface RolePreviewLinks {
  individualNamesByUser?: ReadonlyMap<string, readonly string[]>;
  employeeNamesByUser?: ReadonlyMap<string, readonly string[]>;
  agenciesByUser?: ReadonlyMap<string, readonly RolePreviewLinkedAgency[]>;
  portalAccessByUser?: ReadonlyMap<string, PortalAccessContext>;
  individualNameById?: ReadonlyMap<string, string>;
  employeeNameById?: ReadonlyMap<string, string>;
}

function loginTime(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

type EffectiveAccessKey =
  | "canSeeTransactions"
  | "canSeeMoney"
  | "canSeeHours"
  | "canSeeBilledAmounts"
  | "canSeeEmployeeAmounts"
  | "canSeeAgencySpread"
  | "canSeeCheckNet"
  | "canSeeTaxes"
  | "canSeeBudgets"
  | "canSeeEmployeeDeals"
  | "canSeeSettlements"
  | "canManageSettlements"
  | "canSeeClassFinancials"
  | "canManageClassInvoices"
  | "canEditDocuments"
  | "canPlan";

const EFFECTIVE_ACCESS_FIELDS = [
  { key: "canSeeTransactions", label: "Transactions" },
  { key: "canSeeMoney", label: "Money workspaces" },
  { key: "canSeeHours", label: "Service hours" },
  { key: "canSeeBilledAmounts", label: "Funder billed amounts" },
  { key: "canSeeEmployeeAmounts", label: "Employee base amounts" },
  { key: "canSeeAgencySpread", label: "Agency spread" },
  { key: "canSeeCheckNet", label: "Check net" },
  { key: "canSeeTaxes", label: "Taxes and withholding" },
  { key: "canSeeBudgets", label: "Budgets" },
  { key: "canSeeEmployeeDeals", label: "Employee deals" },
  { key: "canSeeSettlements", label: "Collection reports" },
  { key: "canManageSettlements", label: "Collection changes" },
  { key: "canSeeClassFinancials", label: "Class financials" },
  { key: "canManageClassInvoices", label: "Class invoice changes" },
  { key: "canEditDocuments", label: "Document editing" },
  { key: "canPlan", label: "Schedule planning" },
] as const satisfies readonly { key: EffectiveAccessKey; label: string }[];

function effectiveAccountAccess(user: UserWithAccess): {
  grants: string[];
  denials: string[];
} {
  const grants: string[] = [];
  const denials: string[] = [];
  const trustedStaff = user.role !== "viewer";
  const fullRoster = trustedStaff || user.accessScope === "full";

  if (fullRoster || user.seeAllIndividuals) grants.push("All individuals");
  else if (user.individualCount > 0) grants.push(`Assigned individuals (${user.individualCount})`);
  else denials.push("Internal individual roster");

  if (fullRoster || user.seeAllEmployees) grants.push("All employees");
  else if (user.employeeCount > 0) grants.push(`Assigned employees (${user.employeeCount})`);
  else denials.push("Internal employee roster");

  for (const capability of EFFECTIVE_ACCESS_FIELDS) {
    (trustedStaff || user[capability.key] ? grants : denials).push(capability.label);
  }
  return { grants, denials };
}

const PORTAL_CAPABILITY_LABELS = {
  "agencies.read": "Agency profile",
  "agencies.manage": "Agency setup changes",
  "users.manage": "User administration",
  "people.self.read": "Linked person profile",
  "people.agency.read": "Dated agency roster",
  "people.agency.manage": "Dated agency roster changes",
  "assignments.self.read": "Own assignments",
  "assignments.agency.manage": "Agency assignment changes",
  "schedules.self.read": "Approved personal schedule",
  "schedules.agency.read": "Agency schedule",
  "schedules.agency.manage": "Agency schedule changes",
  "hours_budgets.self.read": "Linked hours and budgets",
  "hours_budgets.agency.read": "Agency hours and budgets",
  "hours_budgets.agency.manage": "Agency hour and budget changes",
  "dollar_budgets.self.read": "Linked dollar budgets",
  "dollar_budgets.agency.read": "Agency dollar budgets",
  "transactions.self.read": "Linked transactions",
  "transactions.agency.read": "Agency transactions",
  "employee_pay.self.read": "Own direct-pay history",
  "employee_checks.self.gross.read": "Own check gross",
  "employee_checks.self.net.read": "Own check net",
  "employee_checks.self.tax.read": "Own check withholding",
  "employee_giveback.self.read": "Own give-back balance",
  "financials.self.billed_totals.read": "Linked funder-billed totals",
  "financials.self.cuts_set_asides.read": "Linked cuts and set-asides",
  "financials.self.direct_checks.read": "Linked direct checks",
  "financials.self.agency_paid.read": "Linked agency-paid totals",
  "financials.agency.billed_totals.read": "Agency funder-billed totals",
  "financials.agency.cuts_set_asides.read": "Agency cuts and set-asides",
  "financials.agency.direct_checks.read": "Agency direct checks",
  "financials.agency.agency_paid.read": "Agency-paid totals",
  "settlements.agency.read": "Agency settlement reports",
  "settlements.agency.manage": "Agency settlement changes",
  "documents.self.read": "Linked documents",
} as const satisfies Record<PortalCapability, string>;

function capabilityLabels(capabilities: readonly PortalCapability[]): string[] {
  return capabilities.map((capability) => PORTAL_CAPABILITY_LABELS[capability]);
}

function explicitDenials(
  policies: readonly { denials: readonly PortalCapability[] }[],
): string[] {
  const denied = new Set(policies.flatMap((policy) => policy.denials));
  return capabilityLabels([...denied]);
}

/**
 * Summarize the same effective capability decisions used by real portal reads.
 * Scope stays separate so a denial for one person or agency is never presented
 * as a global denial (or accidentally hidden by a grant on another scope).
 */
export function effectivePortalScopes(
  context: PortalAccessContext,
  names: {
    individualNameById?: ReadonlyMap<string, string>;
    employeeNameById?: ReadonlyMap<string, string>;
  } = {},
): RolePreviewPortalScope[] {
  if (isPortalOwner(context)) {
    const owners = context.globalRoles.filter((assignment) => assignment.role === "owner");
    return [{
      key: "owner",
      label: "All portal records",
      effectiveGrants: capabilityLabels(portalCapabilities(context)),
      effectiveDenials: explicitDenials(owners),
    }];
  }

  const scopes: RolePreviewPortalScope[] = [];
  const individualIds = [...new Set(
    context.individualLinks.map((link) => link.individualId),
  )];
  for (const [index, individualId] of individualIds.entries()) {
    const links = context.individualLinks.filter((link) => link.individualId === individualId);
    const roles = context.globalRoles.filter((assignment) => links.some((link) =>
      assignment.role === (link.relationship === "self" ? "individual" : "parent")));
    scopes.push({
      key: `individual:${individualId}`,
      label: names.individualNameById?.get(individualId)
        ?? `Linked individual ${index + 1}`,
      effectiveGrants: capabilityLabels(
        portalIndividualCapabilities(context, individualId),
      ),
      effectiveDenials: explicitDenials([...roles, ...links]),
    });
  }

  for (const [index, link] of context.employeeLinks.entries()) {
    const roles = context.globalRoles.filter((assignment) => assignment.role === "employee");
    scopes.push({
      key: `employee:${link.employeeId}`,
      label: names.employeeNameById?.get(link.employeeId)
        ?? `Linked employee ${index + 1}`,
      effectiveGrants: capabilityLabels(
        portalEmployeeCapabilities(context, link.employeeId),
      ),
      effectiveDenials: explicitDenials([...roles, link]),
    });
  }

  const agencyIds = [...new Set(context.agencyAccess.map((assignment) => assignment.agencyId))];
  for (const agencyId of agencyIds) {
    const assignments = context.agencyAccess.filter(
      (assignment) => assignment.agencyId === agencyId,
    );
    const agency = assignments[0];
    if (!agency) continue;
    scopes.push({
      key: `agency:${agencyId}`,
      label: agency.agencyName,
      effectiveGrants: capabilityLabels(portalCapabilities(context, agencyId)),
      effectiveDenials: explicitDenials(assignments),
    });
  }
  return scopes;
}

/** Build active preview choices in preset order, preferring a usable recent account. */
export function buildRolePreviewAccounts(
  users: readonly UserWithAccess[],
  currentUserId: string,
  links: RolePreviewLinks = {},
): Record<AccountPresetId, RolePreviewAccount[]> {
  const result = Object.fromEntries(
    ACCOUNT_PRESETS.map((preset) => [preset.id, [] as RolePreviewAccount[]]),
  ) as unknown as Record<AccountPresetId, RolePreviewAccount[]>;

  for (const user of users) {
    if (!user.isActive) continue;
    const presetId = previewPresetForUser(user);
    if (!presetId) continue;
    const effectiveAccess = effectiveAccountAccess(user);
    const portalAccess = links.portalAccessByUser?.get(user.id);
    result[presetId].push({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      lastLoginAt: user.lastLoginAt,
      isCurrent: user.id === currentUserId,
      seeAllIndividuals: user.seeAllIndividuals,
      seeAllEmployees: user.seeAllEmployees,
      individualAccessCount: user.individualCount,
      employeeAccessCount: user.employeeCount,
      linkedIndividuals: [...(links.individualNamesByUser?.get(user.id) ?? [])],
      linkedEmployees: [...(links.employeeNamesByUser?.get(user.id) ?? [])],
      linkedAgencies: [...(links.agenciesByUser?.get(user.id) ?? [])],
      effectiveGrants: effectiveAccess.grants,
      effectiveDenials: effectiveAccess.denials,
      portalScopes: portalAccess
        ? effectivePortalScopes(portalAccess, {
            individualNameById: links.individualNameById,
            employeeNameById: links.employeeNameById,
          })
        : [],
    });
  }

  for (const accounts of Object.values(result)) {
    accounts.sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) return left.isCurrent ? 1 : -1;
      const recent = loginTime(right.lastLoginAt) - loginTime(left.lastLoginAt);
      if (recent !== 0) return recent;
      return left.displayName.localeCompare(right.displayName);
    });
  }
  return result;
}
