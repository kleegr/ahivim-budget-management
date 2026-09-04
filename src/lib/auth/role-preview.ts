import {
  ACCOUNT_PRESETS,
  type AccountPresetId,
} from "@/lib/auth/account-presets";
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
    landingHref: "/schedule",
    landingLabel: "Schedule",
    visible: "Planning roster, authorized, actual, scheduled, and remaining hours, renewals, pace, assignments, availability, time off, and direct-pay targets as hours.",
    hidden: "Rates, dollars, transactions, payroll checks, gross, net, taxes, deals, Masser, settlements, and agency spread.",
  },
  staffing_manager: {
    landingHref: "/schedule",
    landingLabel: "Schedule",
    visible: "Employees, availability, time off, assignments, and schedules.",
    hidden: "Budgets, rates, transactions, payroll, settlements, and all other financial information.",
  },
  money_collector: {
    landingHref: "/masser",
    landingLabel: "Masser",
    visible: "Check confirmation, employee collections, agency payments, individual put-away, credits, corrections, and statements.",
    hidden: "Budget planning, funder revenue, agency spread, and the owner-only final agency result.",
  },
  class_billing: {
    landingHref: "/classes",
    landingLabel: "Classes",
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
}

export interface RolePreviewLinks {
  individualNamesByUser?: ReadonlyMap<string, readonly string[]>;
  employeeNamesByUser?: ReadonlyMap<string, readonly string[]>;
  agenciesByUser?: ReadonlyMap<string, readonly RolePreviewLinkedAgency[]>;
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
