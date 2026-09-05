import { describe, expect, it } from "vitest";
import { buildRoleHomeDefinition, type RoleHomeCapabilities } from "@/lib/dashboard/role-home";

const none: RoleHomeCapabilities = {
  canSeeBudgets: false,
  canSeeEmployees: false,
  canSeeTransactions: false,
  canPlan: false,
  canSeeSettlements: false,
  canSeeClassFinancials: false,
  canViewDocuments: false,
  canEditDocuments: false,
  canUsePortal: false,
};

describe("role-specific Home", () => {
  it("puts budget work first without inventing financial access", () => {
    const home = buildRoleHomeDefinition("budget_planner", {
      ...none,
      canSeeBudgets: true,
      canSeeEmployees: true,
      canPlan: true,
    });
    expect(home.title).toBe("Budget planning home");
    expect(home.actions.map((action) => action.id)).toEqual(["people", "schedule", "employees", "account"]);
    expect(home.actions.some((action) => action.id === "masser" || action.id === "transactions")).toBe(false);
  });

  it("puts staffing work first and keeps every money destination out", () => {
    const home = buildRoleHomeDefinition("staffing_manager", {
      ...none,
      canSeeEmployees: true,
      canPlan: true,
    });
    expect(home.actions.map((action) => action.id)).toEqual(["schedule", "employees", "account"]);
  });

  it("puts the collector action queue before its detailed ledger", () => {
    const home = buildRoleHomeDefinition("money_collector", {
      ...none,
      canSeeTransactions: true,
      canSeeSettlements: true,
    });
    expect(home.actions.map((action) => action.id).slice(0, 3)).toEqual(["masser", "settlements", "transactions"]);
  });

  it("honors custom permission adjustments instead of a hard-coded role copy", () => {
    const home = buildRoleHomeDefinition("custom_access", {
      ...none,
      canSeeTransactions: true,
      canViewDocuments: true,
      canEditDocuments: false,
    });
    expect(home.actions.map((action) => action.id)).toEqual(["transactions", "documents", "account"]);
  });
});
