import { describe, expect, it } from "vitest";
import { getCommandDestinations, getVisibleWorkspaces } from "@/lib/nav/app-navigation";

describe("role-specific workspaces", () => {
  it("gives a finance-only viewer Money operations without budget navigation", () => {
    const access = {
      role: "viewer",
      accessResolved: true,
      canSeeTransactions: true,
      canSeeSettlements: true,
      canSeeBudgets: false,
      canPlan: false,
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
      accessResolved: true,
      canSeeTransactions: false,
      canSeeSettlements: false,
      canSeeBudgets: true,
      canPlan: false,
    });
    expect(workspaces.find((workspace) => workspace.id === "budgets")?.href).toBe("/individuals");
  });

  it("gives a budget planner Planning and budgets without transaction navigation", () => {
    const access = {
      role: "viewer",
      accessResolved: true,
      canSeeTransactions: false,
      canSeeSettlements: false,
      canSeeBudgets: true,
      canPlan: true,
    };
    const workspaces = getVisibleWorkspaces(access);

    expect(workspaces.find((workspace) => workspace.id === "budgets")?.href).toBe("/individuals");
    expect(workspaces.find((workspace) => workspace.id === "activity")?.href).toBe("/schedule");
    expect(getCommandDestinations(access).some((item) => item.href === "/schedule")).toBe(true);
    expect(getCommandDestinations(access).some((item) => item.href === "/transactions")).toBe(false);
    expect(workspaces.some((workspace) => workspace.id === "payroll")).toBe(false);
  });

  it("fails closed for gated navigation when capability resolution fails", () => {
    const unresolved = {
      role: "admin",
      accessResolved: false,
      canSeeTransactions: true,
      canSeeSettlements: true,
      canSeeBudgets: true,
      canPlan: true,
    };

    expect(getVisibleWorkspaces(unresolved)).toEqual([]);
    expect(getCommandDestinations(unresolved).map((item) => item.href)).toEqual(["/settings"]);
  });

  it("preserves full navigation after successful capability resolution", () => {
    const resolved = {
      role: "admin",
      accessResolved: true,
      canSeeTransactions: true,
      canSeeSettlements: true,
      canSeeBudgets: true,
      canPlan: true,
    };

    const workspaces = getVisibleWorkspaces(resolved);
    expect(workspaces.map((workspace) => workspace.id)).toEqual([
      "overview",
      "budgets",
      "payroll",
      "activity",
      "review",
      "reports",
    ]);
    const hrefs = getCommandDestinations(resolved).map((item) => item.href);
    expect(hrefs).toContain("/transactions");
    expect(hrefs).toContain("/schedule");
    expect(hrefs).toContain("/individuals");
    expect(hrefs).toContain("/employees");
    expect(hrefs).toContain("/reports");
  });
});
