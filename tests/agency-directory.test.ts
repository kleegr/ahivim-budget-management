import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAgencyDirectoryReadModel,
  findAgencyDirectoryEntry,
} from "@/lib/data/agency-directory";
import type { PortalAgencySummary, PortalHomeReadModel } from "@/lib/data/portal-read-model";

function agency(patch: Partial<PortalAgencySummary> = {}): PortalAgencySummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    code: "A1",
    name: "Agency One",
    roles: [{ key: "owner", label: "Owner" }],
    capabilities: ["agencies.read", "people.agency.read"],
    individualCount: 2,
    employeeCount: 3,
    managedBudgetCount: 1,
    billingWithoutBudgetCount: 1,
    budgetHours: { authorized: "100.0000", used: "40.0000", remaining: "60.0000" },
    budgetDollars: null,
    month: "2026-09",
    billedThisMonth: "1200.0000",
    setAsideThisMonth: "100.0000",
    agencyPaidThisMonth: "700.0000",
    payrollGrossThisMonth: "900.0000",
    payrollNetThisMonth: "800.0000",
    giveBackRemaining: "50.0000",
    individuals: [],
    employees: [],
    ...patch,
  };
}

function portal(agencies: PortalAgencySummary[]): PortalHomeReadModel {
  return {
    month: "2026-09",
    globalRoles: [{ key: "owner", label: "Owner" }],
    globalCapabilities: ["agencies.read"],
    directProfiles: { individualCount: 0, employeeCount: 0 },
    individuals: [],
    employees: [],
    agencies,
  };
}

describe("owner agency directory", () => {
  it("preserves the canonical portal aggregates and totals only visible roster counts", () => {
    const first = agency();
    const second = agency({
      id: "00000000-0000-4000-8000-000000000002",
      code: "A2",
      name: "Agency Two",
      individualCount: 4,
      employeeCount: 5,
      managedBudgetCount: 3,
      billingWithoutBudgetCount: 0,
    });
    const directory = buildAgencyDirectoryReadModel(portal([first, second]));

    expect(directory.agencies[0]).toBe(first);
    expect(directory.totals).toEqual({
      agencies: 2,
      individuals: 6,
      employees: 8,
      managedBudgets: 4,
      billingWithoutBudget: 1,
    });
    expect(findAgencyDirectoryEntry(directory, second.id)).toBe(second);
    expect(findAgencyDirectoryEntry(directory, "00000000-0000-4000-8000-000000000099")).toBeNull();
  });

  it("does not turn hidden category counts into zero", () => {
    const directory = buildAgencyDirectoryReadModel(portal([
      agency(),
      agency({ id: "00000000-0000-4000-8000-000000000002", individualCount: null }),
    ]));
    expect(directory.totals.individuals).toBeNull();
  });

  it("does not link agency totals to a broader person-wide transaction ledger", () => {
    const source = readFileSync("src/components/agencies/agency-profile.tsx", "utf8");
    expect(source).not.toContain("txLink(");
    expect(source).not.toContain('"Actual activity"');
  });

  it("keeps both agency routes owner-only and presentation-only", () => {
    for (const path of [
      "src/app/(app)/agencies/page.tsx",
      "src/app/(app)/agencies/[id]/page.tsx",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain('requireUser("viewer")');
      expect(source).toContain("isPortalOwner(portal)");
      expect(source).toContain('hasPortalCapability(portal, "agencies.read")');
      expect(source).toContain("getPortalHomeReadModel");
      expect(source).not.toContain("listAgencyIndividualMemberships");
      expect(source).not.toContain("getAgencyFinancialReport");
    }
  });

  it("keeps the directory lightweight and scopes a profile read to one agency", () => {
    const directoryRoute = readFileSync("src/app/(app)/agencies/page.tsx", "utf8");
    const profileRoute = readFileSync("src/app/(app)/agencies/[id]/page.tsx", "utf8");
    const readModel = readFileSync("src/lib/data/portal-read-model.ts", "utf8");

    expect(directoryRoute).toContain("{ agencySummaryOnly: true }");
    expect(profileRoute).toContain("{ agencyIds: [id] }");
    expect(readModel).toContain("($3::uuid[] IS NULL OR a.id = ANY($3::uuid[]))");
    expect(readModel).toContain("membership.effective_from < ($4::date + interval '1 month')");
    expect(readModel).toContain("agencySummaryOnly ? [] : peopleAgencyIds");
  });

  it("labels outstanding give-back balances as current rather than month-specific", () => {
    const profile = readFileSync("src/components/agencies/agency-profile.tsx", "utf8");
    expect(profile).toContain("Current give-back remaining");
    expect(profile).toContain("current outstanding give-back balance");
    expect(profile).not.toContain("Employee give-back remaining");
  });
});
