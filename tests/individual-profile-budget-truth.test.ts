import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const profileSource = readFileSync(
  new URL("../src/app/(app)/individuals/[id]/page.tsx", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("../src/components/individuals/program-budget-workspace.tsx", import.meta.url),
  "utf8",
);

describe("individual profile budget truth", () => {
  it("uses canonical program authorizations for the operational Budget tab", () => {
    const budgetStart = profileSource.indexOf('id: "budget"');
    const nextTab = profileSource.indexOf('id: "classes"', budgetStart);
    const budgetPanel = profileSource.slice(budgetStart, nextTab);

    expect(profileSource).toContain("summarizeAuthorizationPortfolio(programBudgetsRaw)");
    expect(profileSource).toContain("operationalBudget.elapsedPct / 100");
    expect(budgetPanel).toContain("<ProgramBudgetWorkspace");
    expect(budgetPanel).not.toContain("<BudgetEditor");
    expect(profileSource).not.toContain('id: "programs"');
  });

  it("keeps calculation strategies explicitly inside Financial setup", () => {
    const financialStart = profileSource.indexOf('id: "financial"');
    const detailsStart = profileSource.indexOf('id: "details"', financialStart);
    const financialPanel = profileSource.slice(financialStart, detailsStart);

    expect(financialPanel).toContain("<BudgetEditor");
    expect(financialPanel).toContain("They do not authorize service or change the balances shown in Budget");
  });

  it("shows scheduled balances and canonical monthly trend per authorization", () => {
    expect(workspaceSource).toContain("After schedule");
    expect(workspaceSource).toContain("Monthly authorization trend");
    expect(workspaceSource).toContain("Used comes from committed transactions");
    expect(workspaceSource).toContain("Group service totals are hours credited to this individual");
  });
});
