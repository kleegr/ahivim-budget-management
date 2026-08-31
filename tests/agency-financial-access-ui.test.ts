import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getCommandDestinations, getVisibleWorkspaces } from "@/lib/nav/app-navigation";

const page = readFileSync("src/app/(app)/reports/agency-financials/page.tsx", "utf8");
const workspace = readFileSync("src/components/reports/agency-financial-workspace.tsx", "utf8");
const reportLibrary = readFileSync("src/app/(app)/reports/page.tsx", "utf8");
const incomeApi = readFileSync("src/app/api/agency-financials/income/route.ts", "utf8");
const splitApi = readFileSync("src/app/api/agency-financials/program-splits/route.ts", "utf8");
const payRuleApi = readFileSync("src/app/api/agency-financials/employee-terms/route.ts", "utf8");

const baseAccess = {
  canSeeTransactions: true,
  canSeeSettlements: true,
  canSeeBudgets: true,
  canPlan: true,
  canSeeClassFinancials: true,
  canSeeEmployees: true,
  canEditDocuments: true,
  canUsePortal: true,
  canManageAgencies: true,
  accessResolved: true,
};

describe("owner agency financials access and interface", () => {
  it("guards the page as administrator-only and hides its report card from managers", () => {
    expect(page).toContain('requireUser("admin")');
    expect(reportLibrary).toContain('report.ownerOnly && user.role !== "admin"');
    for (const api of [incomeApi, splitApi, payRuleApi]) expect(api).toContain('apiUser("admin")');

    const manager = { ...baseAccess, role: "manager" };
    const owner = { ...baseAccess, role: "admin" };
    expect(getCommandDestinations(manager).some((item) => item.href === "/reports/agency-financials")).toBe(false);
    expect(getCommandDestinations(owner).some((item) => item.href === "/reports/agency-financials")).toBe(true);
    expect(getVisibleWorkspaces(manager).some((item) => item.href === "/reports/agency-financials")).toBe(false);
  });

  it("exposes clear month navigation, source drilldowns, disclosures, and all owner actions", () => {
    for (const text of [
      "Actual income",
      "Expenses",
      "Agency result",
      "Google Sheet transactions",
      "Issued class invoices",
      "Current approved monthly set-asides",
      "Payroll taxes (gross - net)",
      "Add income",
      "Program split",
      "Employee pay rule",
      "Void income entry",
      "Previous month",
      "Next month",
    ]) expect(workspace).toContain(text);
    expect(workspace).toContain("Historical setup revisions are not reconstructed");
    expect(workspace).toContain("transactionId=${row.id}");
    expect(workspace).toContain("openPayRule({ employeeId: row.employeeId!");
    expect(workspace).toContain("openProgramSplit({ individualId: row.individualId");
    expect(workspace).toContain("/employees/${row.employeeId}?view=deal");
    expect(workspace).toContain("/individuals/${row.individualId}?view=financial");
    expect(workspace).toContain("/individuals/${individualId}?view=budget");
    expect(workspace).toContain("agencyDate()");
  });
});
