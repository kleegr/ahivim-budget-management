import type { AccessScope } from "./access";
import {
  BUDGET_PLANNER_ACCESS,
  CLASS_BILLING_ACCESS,
  COLLECTIONS_ACCESS,
  PORTAL_ONLY_ACCESS,
  STAFFING_MANAGER_ACCESS,
} from "./access-presets";
import { getAccountPreset, type AccountPresetId } from "./account-presets";
import type { PortalAccessContext } from "./portal-access";
import type { UserAccessConfig } from "./users";

export type AccountProfileId = AccountPresetId | "portal";

export interface AccountProfile {
  id: AccountProfileId;
  label: string;
}

const INTERNAL_PRESETS: ReadonlyArray<{
  id: AccountPresetId;
  access: UserAccessConfig;
}> = [
  { id: "budget_planner", access: BUDGET_PLANNER_ACCESS },
  { id: "staffing_manager", access: STAFFING_MANAGER_ACCESS },
  { id: "money_collector", access: COLLECTIONS_ACCESS },
  { id: "class_billing", access: CLASS_BILLING_ACCESS },
];

function resolvedAccess(scope: AccessScope): UserAccessConfig {
  return {
    accessScope: scope.full ? "full" : "scoped",
    seeAllIndividuals: scope.allIndividuals,
    seeAllEmployees: scope.allEmployees,
    canSeeTransactions: scope.canSeeTransactions,
    canSeeMoney: scope.canSeeMoney,
    canSeeHours: scope.canSeeHours,
    canSeeBilledAmounts: scope.canSeeBilledAmounts,
    canSeeEmployeeAmounts: scope.canSeeEmployeeAmounts,
    canSeeAgencySpread: scope.canSeeAgencySpread,
    canSeeCheckNet: scope.canSeeCheckNet,
    canSeeTaxes: scope.canSeeTaxes,
    canSeeBudgets: scope.canSeeBudgets,
    canSeeEmployeeDeals: scope.canSeeEmployeeDeals,
    canSeeSettlements: scope.canSeeSettlements,
    canManageSettlements: scope.canManageSettlements,
    canSeeClassFinancials: scope.canSeeClassFinancials,
    canManageClassInvoices: scope.canManageClassInvoices,
    canEditDocuments: scope.canEditDocuments,
    canPlan: scope.canPlan,
    individualIds: scope.grantedIndividualIds,
    employeeIds: scope.grantedEmployeeIds,
  };
}

function sameStringSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function accessMatches(left: UserAccessConfig, right: UserAccessConfig) {
  return left.accessScope === right.accessScope
    && left.seeAllIndividuals === right.seeAllIndividuals
    && left.seeAllEmployees === right.seeAllEmployees
    && left.canSeeTransactions === right.canSeeTransactions
    && left.canSeeMoney === right.canSeeMoney
    && left.canSeeHours === right.canSeeHours
    && left.canSeeBilledAmounts === right.canSeeBilledAmounts
    && left.canSeeEmployeeAmounts === right.canSeeEmployeeAmounts
    && left.canSeeAgencySpread === right.canSeeAgencySpread
    && left.canSeeCheckNet === right.canSeeCheckNet
    && left.canSeeTaxes === right.canSeeTaxes
    && left.canSeeBudgets === right.canSeeBudgets
    && left.canSeeEmployeeDeals === right.canSeeEmployeeDeals
    && left.canSeeSettlements === right.canSeeSettlements
    && left.canManageSettlements === right.canManageSettlements
    && left.canSeeClassFinancials === right.canSeeClassFinancials
    && left.canManageClassInvoices === right.canManageClassInvoices
    && left.canEditDocuments === right.canEditDocuments
    && left.canPlan === right.canPlan
    && sameStringSet(left.individualIds, right.individualIds)
    && sameStringSet(left.employeeIds, right.employeeIds);
}

function portalProfile(portal: PortalAccessContext): AccountProfileId | null {
  const profiles = new Set<AccountPresetId>();
  const globalRoles = new Set(portal.globalRoles.map((assignment) => assignment.role));

  if (
    portal.individualLinks.length > 0
    && (globalRoles.has("individual") || globalRoles.has("parent"))
  ) profiles.add("individual_parent");
  if (portal.employeeLinks.length > 0 && globalRoles.has("employee")) {
    profiles.add("employee");
  }

  const agencyProfiles: Record<string, AccountPresetId> = {
    agency: "agency",
    scheduler: "agency_scheduler",
    staffing_manager: "agency_staffing_manager",
    collector: "agency_collector",
  };
  for (const assignment of portal.agencyAccess) {
    const profile = agencyProfiles[assignment.role];
    if (profile) profiles.add(profile);
  }

  if (profiles.size === 1) return [...profiles][0]!;
  const hasPortalAccess = portal.globalRoles.length > 0
    || portal.agencyAccess.length > 0
    || portal.individualLinks.length > 0
    || portal.employeeLinks.length > 0;
  return hasPortalAccess ? "portal" : null;
}

function profileLabel(id: AccountProfileId) {
  if (id === "portal") return "Portal account";
  return getAccountPreset(id)?.label ?? "Custom access";
}

/** A simple user-facing name for the account's effective portal and permissions. */
export function resolveAccountProfile(
  role: string,
  scope: AccessScope | null,
  portal: PortalAccessContext | null,
  storedPreset?: AccountPresetId | null,
): AccountProfile {
  const selected = storedPreset ? getAccountPreset(storedPreset) : null;
  if (selected?.role === role) return { id: selected.id, label: selected.label };
  if (role === "admin") return { id: "owner", label: profileLabel("owner") };
  if (role === "manager") return { id: "office_manager", label: profileLabel("office_manager") };

  if (scope) {
    const access = resolvedAccess(scope);
    if (accessMatches(access, PORTAL_ONLY_ACCESS)) {
      const portalId = portal ? portalProfile(portal) : null;
      if (portalId) return { id: portalId, label: profileLabel(portalId) };
      return { id: "custom_access", label: profileLabel("custom_access") };
    }

    const preset = INTERNAL_PRESETS.find((candidate) => accessMatches(access, candidate.access));
    if (preset) return { id: preset.id, label: profileLabel(preset.id) };
  }

  return { id: "custom_access", label: profileLabel("custom_access") };
}
