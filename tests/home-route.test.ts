import { describe, expect, it } from "vitest";
import { fullAccess, type AccessScope } from "@/lib/auth/access";
import {
  BUDGET_PLANNER_ACCESS,
  CLASS_BILLING_ACCESS,
  COLLECTIONS_ACCESS,
  PORTAL_ONLY_ACCESS,
  STAFFING_MANAGER_ACCESS,
} from "@/lib/auth/access-presets";
import type { PortalAccessContext } from "@/lib/auth/portal-access";
import { viewerHomePath } from "@/lib/nav/home-route";

function viewerAccess(patch: Partial<AccessScope> = {}): AccessScope {
  return {
    ...fullAccess("00000000-0000-4000-8000-000000000001", "viewer"),
    full: false,
    allIndividuals: false,
    allEmployees: false,
    individualIds: [],
    employeeIds: [],
    grantedIndividualIds: [],
    grantedEmployeeIds: [],
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
    canPlan: false,
    canSeeClassFinancials: false,
    canManageClassInvoices: false,
    canEditDocuments: false,
    ...patch,
  };
}

const EMPTY_PORTAL: PortalAccessContext = {
  userId: "00000000-0000-4000-8000-000000000001",
  globalRoles: [],
  agencyAccess: [],
  individualLinks: [],
  employeeLinks: [],
};

function portalAccess(patch: Partial<PortalAccessContext>): PortalAccessContext {
  return { ...EMPTY_PORTAL, ...patch };
}

describe("viewerHomePath", () => {
  it("opens Classes for a class-financial-only account", () => {
    expect(viewerHomePath(viewerAccess({ canSeeMoney: true, canSeeClassFinancials: true }), EMPTY_PORTAL))
      .toBe("/classes");
  });

  it("opens the PDF editor for a document-only account", () => {
    expect(viewerHomePath(viewerAccess({ canEditDocuments: true }), EMPTY_PORTAL))
      .toBe("/documents");
  });

  it("uses Employees only when the account can actually see employees", () => {
    expect(viewerHomePath(viewerAccess({ employeeIds: ["00000000-0000-4000-8000-000000000002"] }), EMPTY_PORTAL))
      .toBe("/employees");
    expect(viewerHomePath(viewerAccess(), EMPTY_PORTAL)).toBe("/settings");
  });

  it.each([
    [
      "budget planner",
      { ...BUDGET_PLANNER_ACCESS, allIndividuals: true, allEmployees: true },
      EMPTY_PORTAL,
      "/schedule",
    ],
    [
      "staffing manager",
      { ...STAFFING_MANAGER_ACCESS, allIndividuals: true, allEmployees: true },
      EMPTY_PORTAL,
      "/schedule",
    ],
    ["money collector", COLLECTIONS_ACCESS, EMPTY_PORTAL, "/masser"],
    ["class billing", CLASS_BILLING_ACCESS, EMPTY_PORTAL, "/classes"],
    [
      "employee",
      PORTAL_ONLY_ACCESS,
      portalAccess({
        globalRoles: [{ role: "employee", grants: [], denials: [] }],
        employeeLinks: [{
          employeeId: "00000000-0000-4000-8000-000000000002",
          relationship: "self",
          grants: [],
          denials: [],
        }],
      }),
      "/portal",
    ],
    [
      "individual or parent",
      PORTAL_ONLY_ACCESS,
      portalAccess({
        globalRoles: [{ role: "parent", grants: [], denials: [] }],
        individualLinks: [{
          individualId: "00000000-0000-4000-8000-000000000003",
          relationship: "parent",
          grants: [],
          denials: [],
        }],
      }),
      "/portal",
    ],
    [
      "agency",
      PORTAL_ONLY_ACCESS,
      portalAccess({
        agencyAccess: [{
          agencyId: "00000000-0000-4000-8000-000000000004",
          agencyCode: "AGENCY",
          agencyName: "Agency",
          role: "agency",
          grants: [],
          denials: [],
        }],
      }),
      "/portal",
    ],
    [
      "agency scheduler",
      PORTAL_ONLY_ACCESS,
      portalAccess({
        agencyAccess: [{
          agencyId: "00000000-0000-4000-8000-000000000004",
          agencyCode: "AGENCY",
          agencyName: "Agency",
          role: "scheduler",
          grants: [],
          denials: [],
        }],
      }),
      "/schedule",
    ],
    [
      "agency staffing manager",
      PORTAL_ONLY_ACCESS,
      portalAccess({
        agencyAccess: [{
          agencyId: "00000000-0000-4000-8000-000000000004",
          agencyCode: "AGENCY",
          agencyName: "Agency",
          role: "staffing_manager",
          grants: [],
          denials: [],
        }],
      }),
      "/schedule",
    ],
    [
      "agency collector",
      PORTAL_ONLY_ACCESS,
      portalAccess({
        agencyAccess: [{
          agencyId: "00000000-0000-4000-8000-000000000004",
          agencyCode: "AGENCY",
          agencyName: "Agency",
          role: "collector",
          grants: [],
          denials: [],
        }],
      }),
      "/portal",
    ],
  ] as const)("opens the correct first workspace for the %s preset", (_label, access, portal, expected) => {
    expect(viewerHomePath(viewerAccess(access), portal)).toBe(expected);
  });
});
