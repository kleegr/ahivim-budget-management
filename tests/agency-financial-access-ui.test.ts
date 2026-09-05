import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getCommandDestinations, getVisibleWorkspaces } from "@/lib/nav/app-navigation";

const page = readFileSync("src/app/(app)/reports/agency-financials/page.tsx", "utf8");
const workspacePaths = [
  "src/components/reports/agency-financial-workspace.tsx",
  "src/components/reports/agency-financial-shared.tsx",
  "src/components/reports/agency-financial-workspace-forms.tsx",
] as const;
const workspace = workspacePaths.map((path) => readFileSync(path, "utf8")).join("\n");
const reportLibrary = readFileSync("src/app/(app)/reports/page.tsx", "utf8");
const reportAccess = readFileSync("src/lib/data/report-access.ts", "utf8");
const incomeApi = readFileSync("src/app/api/agency-financials/income/route.ts", "utf8");
const manualSeparateApi = readFileSync("src/app/api/agency-financials/income/[id]/count-separately/route.ts", "utf8");
const splitApi = readFileSync("src/app/api/agency-financials/program-splits/route.ts", "utf8");
const payRuleApi = readFileSync("src/app/api/agency-financials/employee-terms/route.ts", "utf8");
const employeePage = readFileSync("src/app/(app)/employees/[id]/page.tsx", "utf8");

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
  it("keeps each report UI module below the transport limit", () => {
    for (const path of workspacePaths) {
      expect(Buffer.byteLength(readFileSync(path))).toBeLessThan(50_000);
    }
  });

  it("guards the page as administrator-only and hides its report card from managers", () => {
    expect(page).toContain('requireUser("admin")');
    expect(reportLibrary).toContain("canAccessReport(report.key, access.data, user.role)");
    expect(reportAccess).toContain('"agency-financials": { organizationWide: true, adminOnly: true }');
    for (const api of [incomeApi, manualSeparateApi, splitApi, payRuleApi]) {
      expect(api).toContain('apiUser("admin")');
      expect(api).toContain("sameOriginOrFail(request)");
    }

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
      "Class invoice receivables",
      "Approved monthly set-asides",
      "Verified payroll withholding",
      "How transaction income is divided",
      "Funder billed",
      "Employee base",
      "Agency spread",
      "Employee share of base",
      "Agency share of base",
      "Add income",
      "Program split",
      "Employee pay rule",
      "Void income entry",
      "Previous month",
      "Next month",
    ]) expect(workspace).toContain(text);
    expect(workspace).not.toContain("Current approved monthly set-asides");
    expect(workspace).toContain("August 2026 is the first month with trustworthy setup history");
    expect(workspace).toContain("Earlier months cannot be reconstructed and are not counted");
    expect(workspace).toContain("saved setup snapshots are used when available");
    expect(workspace).toContain("setAsideHistoriesUnavailable");
    expect(workspace).toContain("Rule source");
    expect(workspace).toContain("History snapshot #{row.revisionNumber}");
    expect(workspace).toContain("Superseded because:");
    expect(workspace).toContain("Snapshot recorded");
    expect(workspace).not.toContain("Change reason:");
    expect(workspace).toContain("row.revisionReason");
    expect(workspace).toContain("row.revisionCreatedAt");
    expect(workspace).toContain("Current setup");
    expect(workspace).toContain("History unavailable");
    expect(workspace).toContain("Not counted");
    expect(workspace).toContain("Invoices are not cash receipts");
    expect(workspace).toContain("Individual (required without invoice number)");
    expect(workspace).toContain("Program (required without invoice number)");
    expect(workspace).toContain("required={dimensionsRequired}");
    expect(workspace).toContain("Actual class payments appear only after a Google Sheet transaction arrives or you record the payment below");
    expect(workspace).toContain("Reference only");
    expect(workspace).toContain("Not actual cash income");
    expect(workspace).not.toContain("/count-separately`\n      : `/api/agency-financials/income");
    expect(workspace).not.toContain("The invoice will then count as income");
    expect(workspace).toContain("manualIncomeDuplicatesExcluded");
    expect(workspace).toContain("Counted separately");
    expect(workspace).toContain("Count separately");
    expect(workspace).toContain("Treat as same payment");
    expect(workspace).toContain('action: "treat_as_same_payment"');
    expect(workspace).toContain("Why is this a separate payment?");
    expect(workspace).toContain("Why are these the same payment?");
    expect(workspace).toContain("its individual split is already included");
    expect(workspace).toContain("splitAlreadyCounted: reportRow.countedSplitExpense");
    expect(workspace).toContain("Reason: {reportRow.countSeparatelyReason}");
    expect(workspace).toContain("transactionId=${source.sourceId}");
    expect(workspace).toContain("Linked to Sheet payment");
    expect(workspace).toContain("Gross comes from");
    expect(workspace).toContain("Individual split comes from this receipt");
    expect(workspace).toContain("Google Sheet transactions, class receipts, and other recorded payments");
    expect(workspace).toContain("Actual class receipts");
    expect(workspace).toContain("Recorded receipts and other income");
    expect(workspace).toContain("same-payment gross");
    expect(workspace).toContain("Class receipt individual share");
    expect(workspace).toContain("Date basis:");
    expect(workspace).toContain("service month, using period begin, otherwise check date, otherwise period end");
    expect(workspace).toContain("Funder billed = Employee base + Agency spread");
    expect(workspace).toContain("Funder billed = Agency spread + Employee share of base + Agency share of base");
    expect(workspace).toContain("Direct-pay deal amounts stay check-level and use verified net");
    expect(workspace).toContain("missing verified withholding");
    expect(workspace).toContain("Withholding comes from its separately verified check field");
    expect(workspace).toContain("missing values are disclosed and excluded, never inferred from gross minus net");
    expect(workspace).not.toContain("gross - net");
    expect(workspace).toContain("Incomplete values stay out of the money split");
    expect(workspace).toContain("missing base, spread, or deal amounts are not guessed");
    expect(workspace).toContain("Individual split included");
    expect(workspace).toContain("transactionId=${row.id}");
    expect(workspace).toContain("serviceFrom=${report.periodStart}&serviceTo=${report.periodEnd}");
    expect(workspace).toContain("openPayRule({ employeeId: row.employeeId!");
    expect(workspace).toContain("openProgramSplit({ individualId: row.individualId");
    expect(workspace).toContain('className="touch-table min-w-full');
    expect(workspace).toContain("touch-target shrink-0 border-b-2");
    expect(workspace).toContain("firstMissingTransactionAmount.id");
    expect(workspace).toContain("firstMissingDirectDeal.employeeId");
    expect(workspace).toContain("firstMissingApprovedFinal.individualId");
    expect(workspace).toContain("Fix transaction");
    expect(workspace).toContain("Repair program link");
    expect(workspace).toContain("Repair Classes budget link");
    expect(workspace).toContain("reconciles every issued or voided invoice in that allowance");
    expect(workspace).toContain("Invoice dates and amounts do not change");
    expect(workspace).toContain("Repair allowance and history");
    expect(workspace).toContain('href="/settings#programs"');
    expect(workspace).toContain("use Repair program link again");
    expect(workspace).not.toContain("Missing people");
    expect(workspace).not.toContain("Link program first");
    expect(workspace).toContain("/employees/${row.employeeId}?view=deal");
    expect(workspace).toContain("/individuals/${row.individualId}?view=financial");
    expect(workspace).toContain("/individuals/${individualId}?view=budget");
    expect(workspace).toContain("agencyDate()");
    expect(workspace).toContain("effectiveFrom: firstMissingPayRule.serviceDate");
    expect(workspace).toContain("effectiveFrom: firstMissingClassSplit.invoiceDate");
    expect(workspace).toContain("?view=deal&effectiveFrom=${row.serviceDate}");
    expect(workspace).toContain("Not counted - history locked");
    expect(page).toContain("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(page).toContain("normalizeActualAgencyFinancialMonth(requested)");
    expect(workspace).toContain("Next month unavailable");
    expect(workspace).toContain("report.month < agencyDate().slice(0, 7)");
    expect(page).toContain("getAgencyFinancialReport(client, month)");
    expect(page).toContain("listManualIncomeEntries(client");
    expect(employeePage).toContain("requestedEffectiveFrom ?? currentDeal?.effectiveFrom ?? today");
  });
});
