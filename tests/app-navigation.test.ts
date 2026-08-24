import { describe, expect, it } from "vitest";
import { getCommandDestinations, getVisibleWorkspaces } from "@/lib/nav/app-navigation";

describe("role-specific workspaces", () => {
  it("gives a finance-only viewer Money operations without budget navigation", () => {
    const access = {
      role: "viewer",
      canSeeTransactions: true,
      canSeeSettlements: true,
      canSeeBudgets: false,
    };
    const workspaces = getVisibleWorkspaces(access);

    expect(workspaces.map((workspace) => workspace.label)).toContain("Money operations");
    expect(workspaces.map((workspace) => workspace.label)).not.toContain("Budgets");
    expect(workspaces.find((workspace) => workspace.id === "payroll")?.href).toBe("/settlements");
    expect(getCommandDestinations(access).some((item) => item.href === "/individuals")).toBe(false);
  });

  it("keeps the budget portfolio available to a budget viewer", () => {
    const workspaces = getVisibleWorkspaces({
      role: "viewer",
      canSeeTransactions: false,
      canSeeSettlements: false,
      canSeeBudgets: true,
    });
    expect(workspaces.find((workspace) => workspace.id === "budgets")?.href).toBe("/individuals");
  });
});
