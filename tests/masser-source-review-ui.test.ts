import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CollectionsWorkspace from "@/components/collections/collections-workspace";
import type { CollectionsWorkspaceData, PayrollCheckRow } from "@/lib/data/direct-pay-operations";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function data(): CollectionsWorkspaceData {
  return { month: "2026-09", setupHistoryAvailable: true, ledgerDirty: false, employees: [], employeeCollections: [],
    individualSetAsides: [{ individualId: "synthetic-person", individualName: "Synthetic individual",
      approvedMonthlyPlan: "200.0000", setAsideThisMonth: "20.0000", remainingSetAside: "0.0000",
      activePlans: 1, trackedPlans: 1, actionablePlans: 0, reviewRequiredPlans: 1, missingRenewalPlans: 0 }],
    targets: [], payrollChecks: [], payrollCheckCounts: { total: 0, unverified: 0 },
    visibility: { canSeeTargetMoney: true, canSeeTargetHours: true, canSeeCheckGross: true, canSeeCheckNet: true, canSeeTaxes: true },
    summary: { dueFromChecks: "0.0000", collectedThisMonth: "0.0000", remainingReceivable: "0.0000",
      approvedMonthlySetAside: "200.0000", setAsideThisMonth: "20.0000" } };
}
function render(value: CollectionsWorkspaceData, options: { manager?: boolean; checks?: boolean } = {}) {
  return renderToStaticMarkup(createElement(CollectionsWorkspace, { data: value, canManage: options.manager ?? true,
    canSeeEmployeeDeals: false, canManageEmployeeDeals: false, canSeeTransactions: true,
    canManageFinancialPlans: options.manager ?? true, canRepairImports: true, initialView: options.checks ? "checks" : "summary" }));
}
describe("Masser source review and check-count display", () => {
  it("retains a prefilled employee beyond the bounded initial choices and its form field", () => {
    const value = data(); value.employees = Array.from({ length: 201 }, (_, index) => ({ id: `scoped-employee-${index}`, name: `Scoped worker ${index}` }));
    const html = renderToStaticMarkup(createElement(CollectionsWorkspace, { data: value, canManage: true, canSeeEmployeeDeals: false, canManageEmployeeDeals: false, canSeeTransactions: true, canManageFinancialPlans: true, canRepairImports: false, initialView: "checks", initialCheckDraft: { employeeId: "scoped-employee-200", checkNumber: "", checkDate: null, periodBegin: null, periodEnd: null, sourceTransactionIds: [] } }));
    expect(html).toContain('aria-label="Search employees"');
    expect(html).toContain('name="employeeId"');
    expect(html).toContain('value="scoped-employee-200" selected=""');
    expect(html).toContain("Showing the first 100 matches");
    expect(html).not.toContain("outside-scope-worker");
  });

  it("keeps approved monthly and actual cash visible while replacing Ready and the held-only record action", () => {
    const html = render(data());
    expect(html).toContain("$200.00"); expect(html).toContain("$20.00");
    expect(html).toContain("Source review required"); expect(html).toContain("Held balances excluded");
    expect(html).not.toContain(">Ready<"); expect(html).not.toContain("Record set-aside");
    expect(html).toContain("/settlements?individualId=synthetic-person");
    expect(html).toContain("/individuals/synthetic-person?view=financial");
  });
  it("keeps a known remaining reserve actionable in a mixed known/held individual", () => {
    const value = data(); value.individualSetAsides[0]!.actionablePlans = 1;
    value.individualSetAsides[0]!.remainingSetAside = "70.0000";
    expect(render(value)).toContain("Record set-aside");
    expect(render(value)).toContain("Source review required");
  });
  it("blocks a record action and Ready on a globally unprocessed ledger even when the plan is known", () => {
    const value = data(); value.ledgerDirty = true;
    Object.assign(value.individualSetAsides[0]!, { actionablePlans: 1, reviewRequiredPlans: 0, remainingSetAside: "70.0000" });
    const html = render(value);
    expect(html).toContain("Money calculations need refresh"); expect(html).toContain("Refresh needed");
    expect(html).not.toContain("Record set-aside"); expect(html).not.toContain(">Ready<");
  });
  it("keeps the selected monthly item ready while disclosing separate historical holds", () => {
    const value = data();
    Object.assign(value.individualSetAsides[0]!, { actionablePlans: 1, reviewRequiredPlans: 0,
      historicalReviewRequiredPlans: 1, remainingSetAside: "70.0000" });
    const html = render(value);
    expect(html).toContain(">Ready<"); expect(html).toContain("Record set-aside");
    expect(html).toContain("Historical balances remain on hold"); expect(html).toContain("Review historical holds");
    expect(html).not.toContain("Source review required");
  });
  it("does not expose financial setup editing or record actions to a read-only viewer", () => {
    const html = render(data(), { manager: false });
    expect(html).toContain("Source review required");
    expect(html).not.toContain("Review Financial Setup"); expect(html).not.toContain("Record set-aside");
  });
  it("offers review rather than a dead collection action for held employee balances", () => {
    const value = data(); value.employeeCollections = [{ employeeId: "synthetic-employee", employeeName: "Synthetic employee",
      obligationsCreated: 0, dueFromChecks: "0.0000", collectedThisMonth: "20.0000", refundedThisMonth: "0.0000",
      remainingReceivable: "0.0000", availableCredit: "0.0000" }];
    const html = render(value);
    expect(html).toContain("Review money operations"); expect(html).not.toContain("Record collection");
  });
  it("shows the full scoped count and identifies the displayed slice rather than claiming only 100 need review", () => {
    const value = data(); value.payrollCheckCounts = { total: 688, unverified: 688 };
    value.payrollChecks = Array.from({ length: 100 }, (_, i): PayrollCheckRow => ({
      id: `synthetic-check-${i}`, employeeId: "synthetic-employee", employeeName: "Synthetic employee",
      checkNumber: `${i}`, checkDate: null, periodBegin: null, periodEnd: null, actualGross: "100.0000",
      actualNet: "80.0000", taxWithheld: null, source: "import", sourceRef: null, verificationStatus: "unverified",
      notes: null, linkedTransactions: 0, transactionIds: [], updatedAt: "2026-09-08T00:00:00Z",
    }));
    const html = render(value, { checks: true });
    expect(html).toContain("688 payroll checks need"); expect(html).toContain("Showing 100 of 688 payroll checks");
    expect(html).not.toContain("100 imported checks need");
  });
});
