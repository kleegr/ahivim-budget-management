import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveAccountProfile } from "@/lib/auth/account-label";
import {
  BUDGET_PLANNER_ACCESS,
  COLLECTIONS_ACCESS,
  PORTAL_ONLY_ACCESS,
} from "@/lib/auth/access-presets";
import type { AccessScope } from "@/lib/auth/access";
import type { PortalAccessContext } from "@/lib/auth/portal-access";
import type { UserAccessConfig } from "@/lib/auth/users";

function scopeFrom(config: UserAccessConfig): AccessScope {
  return {
    userId: "user-1",
    role: "viewer",
    full: config.accessScope === "full",
    canSeeTransactions: config.canSeeTransactions,
    canSeeMoney: config.canSeeMoney,
    canSeeHours: config.canSeeHours,
    canSeeBilledAmounts: config.canSeeBilledAmounts,
    canSeeEmployeeAmounts: config.canSeeEmployeeAmounts,
    canSeeAgencySpread: config.canSeeAgencySpread,
    canSeeCheckNet: config.canSeeCheckNet,
    canSeeTaxes: config.canSeeTaxes,
    canSeeBudgets: config.canSeeBudgets,
    canSeeEmployeeDeals: config.canSeeEmployeeDeals,
    canSeeSettlements: config.canSeeSettlements,
    canManageSettlements: config.canManageSettlements,
    canSeeClassFinancials: config.canSeeClassFinancials,
    canManageClassInvoices: config.canManageClassInvoices,
    canPlan: config.canPlan,
    canEditDocuments: config.canEditDocuments,
    allIndividuals: config.seeAllIndividuals,
    allEmployees: config.seeAllEmployees,
    individualIds: config.individualIds,
    employeeIds: config.employeeIds,
    grantedIndividualIds: config.individualIds,
    grantedEmployeeIds: config.employeeIds,
  };
}

function portal(overrides: Partial<PortalAccessContext> = {}): PortalAccessContext {
  return {
    userId: "user-1",
    globalRoles: [],
    agencyAccess: [],
    individualLinks: [],
    employeeLinks: [],
    ...overrides,
  };
}

describe("account portal labels", () => {
  it("names internal presets instead of reducing them to Viewer", () => {
    expect(resolveAccountProfile("viewer", scopeFrom(BUDGET_PLANNER_ACCESS), portal())).toEqual({
      id: "budget_planner",
      label: "Budget planner",
    });
    expect(resolveAccountProfile("viewer", scopeFrom(COLLECTIONS_ACCESS), portal())).toEqual({
      id: "money_collector",
      label: "Money collector",
    });
  });

  it("names an agency portal from its assigned agency role", () => {
    const access = portal({
      agencyAccess: [{
        agencyId: "agency-1",
        agencyCode: "AH",
        agencyName: "Ahivim",
        role: "scheduler",
        grants: [],
        denials: [],
      }],
    });
    expect(resolveAccountProfile("viewer", scopeFrom(PORTAL_ONLY_ACCESS), access)).toEqual({
      id: "agency_scheduler",
      label: "Agency scheduler",
    });
  });

  it("uses a clear fallback for a custom or mixed portal", () => {
    expect(resolveAccountProfile("viewer", scopeFrom({
      ...BUDGET_PLANNER_ACCESS,
      canSeeTransactions: true,
    }), portal()).label).toBe("Custom access");

    const mixed = portal({
      globalRoles: [{ role: "employee", grants: [], denials: [] }],
      employeeLinks: [{ employeeId: "employee-1", relationship: "self", grants: [], denials: [] }],
      agencyAccess: [{
        agencyId: "agency-1",
        agencyCode: "AH",
        agencyName: "Ahivim",
        role: "collector",
        grants: [],
        denials: [],
      }],
    });
    expect(resolveAccountProfile("viewer", scopeFrom(PORTAL_ONLY_ACCESS), mixed).label).toBe("Portal account");
  });

  it("keeps internal work access authoritative when portal relationships are also present", () => {
    const employeePortal = portal({
      globalRoles: [{ role: "employee", grants: [], denials: [] }],
      employeeLinks: [{ employeeId: "employee-1", relationship: "self", grants: [], denials: [] }],
    });
    expect(resolveAccountProfile("viewer", scopeFrom(COLLECTIONS_ACCESS), employeePortal).label).toBe("Money collector");
    expect(resolveAccountProfile("viewer", scopeFrom({
      ...COLLECTIONS_ACCESS,
      canPlan: true,
    }), employeePortal).label).toBe("Custom access");
  });

  it("keeps the trusted roles plainly named even if data loading fails", () => {
    expect(resolveAccountProfile("admin", null, null).label).toBe("Owner");
    expect(resolveAccountProfile("manager", null, null).label).toBe("Office manager");
  });

  it("preserves the selected preset name after safe permission adjustments", () => {
    expect(resolveAccountProfile(
      "viewer",
      scopeFrom({ ...BUDGET_PLANNER_ACCESS, canSeeTransactions: true }),
      portal(),
      "budget_planner",
    )).toEqual({ id: "budget_planner", label: "Budget planner" });
  });

  it("describes operational capabilities instead of calling every viewer read-only", () => {
    const settings = readFileSync("src/app/(app)/settings/page.tsx", "utf8");
    expect(settings).toContain("canManageSettlements");
    expect(settings).toContain("canManageClassInvoices");
    expect(settings).toContain("canManagePortalSchedules");
    expect(settings).toContain("input.canSeeBudgets");
    expect(settings).toContain('"schedules and assignments"');
    expect(settings).toContain('manage.push("agency schedules")');
    expect(settings).toContain('manage.push("agency assignments")');
    expect(settings).toContain("Can manage ${readableList(manage)}");
    expect(settings).not.toContain('"Read-only."');
  });
});
