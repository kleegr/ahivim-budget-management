import { describe, expect, it } from "vitest";
import { fullAccess, type AccessScope } from "@/lib/auth/access";
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
});
