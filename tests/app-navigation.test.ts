import { describe, expect, it } from "vitest";
import {
  getCommandDestinations,
  getVisibleAdminDestinations,
  getVisibleWorkspaces,
  shouldTrackNavigation,
} from "@/lib/nav/app-navigation";

describe("role-specific workspaces", () => {
  it("tracks real route changes without flashing progress for the active page", () => {
    expect(shouldTrackNavigation("/dashboard", "/individuals")).toBe(true);
    expect(shouldTrackNavigation("/dashboard", "/dashboard")).toBe(false);
  });

  it("gives a finance-only viewer a plain Masser destination without budget navigation", () => {
    const access = {
      role: "viewer",
      accessResolved: true,
      canSeeTransactions: true,
      canSeeSettlements: true,
      canSeeBudgets: false,
      canPlan: false,
      canEditDocuments: false,
    };
    const workspaces = getVisibleWorkspaces(access);

    expect(workspaces.map((workspace) => workspace.label)).toContain("Masser");
    expect(workspaces.map((workspace) => workspace.label)).not.toContain("People & budgets");
    expect(workspaces.map((workspace) => workspace.label)).not.toContain("Transactions");
    expect(workspaces.find((workspace) => workspace.id === "payroll")?.href).toBe("/masser");
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
      canEditDocuments: false,
    });
    expect(workspaces.find((workspace) => workspace.id === "budgets")?.href).toBe("/individuals");
  });

  it("gives a budget planner Schedule and People & budgets without transaction navigation", () => {
    const access = {
      role: "viewer",
      accessResolved: true,
      canSeeTransactions: false,
      canSeeSettlements: false,
      canSeeBudgets: true,
      canPlan: true,
      canSeeEmployees: true,
      canEditDocuments: false,
    };
    const workspaces = getVisibleWorkspaces(access);

    expect(workspaces.find((workspace) => workspace.id === "budgets")?.href).toBe("/individuals");
    expect(workspaces.find((workspace) => workspace.id === "activity")?.href).toBe("/schedule");
    expect(workspaces.find((workspace) => workspace.id === "employees")?.href).toBe("/employees");
    expect(getCommandDestinations(access).some((item) => item.href === "/schedule")).toBe(true);
    expect(getCommandDestinations(access).some((item) => item.href === "/transactions")).toBe(false);
    expect(workspaces.some((workspace) => workspace.id === "payroll")).toBe(false);
  });

  it("gives an office manager Transactions in the primary workspace list", () => {
    const access = {
      role: "manager",
      accessResolved: true,
      canSeeTransactions: true,
      canSeeSettlements: true,
      canSeeBudgets: true,
      canPlan: true,
      canEditDocuments: true,
    };

    expect(getVisibleWorkspaces(access).find((workspace) => workspace.id === "transactions")?.href).toBe("/transactions");
    expect(getVisibleWorkspaces({ ...access, canSeeTransactions: false }).some((workspace) => workspace.id === "transactions")).toBe(false);
    expect(getCommandDestinations(access).find((item) => item.href === "/transactions")?.label).toBe("Transactions");
  });

  it("gives a class-billing operator Classes and documents without employee money", () => {
    const access = {
      role: "viewer",
      accessResolved: true,
      canSeeTransactions: false,
      canSeeSettlements: false,
      canSeeBudgets: false,
      canPlan: false,
      canSeeClassFinancials: true,
      canSeeEmployees: false,
      canEditDocuments: true,
    };
    const hrefs = getCommandDestinations(access).map((item) => item.href);

    expect(hrefs).toContain("/classes");
    expect(hrefs).toContain("/documents");
    expect(hrefs).not.toContain("/employees");
    expect(hrefs).not.toContain("/transactions");
    expect(hrefs).not.toContain("/settlements");
    expect(hrefs).not.toContain("/schedule");
  });

  it("fails closed for gated navigation when capability resolution fails", () => {
    const unresolved = {
      role: "admin",
      accessResolved: false,
      canSeeTransactions: true,
      canSeeSettlements: true,
      canSeeBudgets: true,
      canPlan: true,
      canEditDocuments: true,
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
      canSeeClassFinancials: true,
      canEditDocuments: true,
      canManageAgencies: true,
    };

    const workspaces = getVisibleWorkspaces(resolved);
    expect(workspaces.map((workspace) => workspace.id)).toEqual([
      "overview",
      "transactions",
      "budgets",
      "activity",
      "payroll",
      "employees",
      "agencies",
      "classes",
      "reports",
    ]);
    const hrefs = getCommandDestinations(resolved).map((item) => item.href);
    expect(hrefs).toContain("/transactions");
    expect(workspaces.find((workspace) => workspace.id === "transactions")?.href).toBe("/transactions");
    expect(hrefs).toContain("/schedule");
    expect(hrefs).toContain("/individuals");
    expect(hrefs).toContain("/employees");
    expect(hrefs).toContain("/classes");
    expect(hrefs).toContain("/reports");
    expect(hrefs).toContain("/documents");
  });

  it("shows the PDF workspace only after document access resolves", () => {
    const base = {
      role: "viewer",
      accessResolved: true,
      canSeeTransactions: false,
      canSeeSettlements: false,
      canSeeBudgets: false,
      canPlan: false,
      canEditDocuments: true,
    };

    expect(getCommandDestinations(base).map((item) => item.href)).toContain("/documents");
    expect(getCommandDestinations({ ...base, canEditDocuments: false }).map((item) => item.href)).not.toContain("/documents");
  });

  it("shows agency administration only to a portal owner", () => {
    const base = {
      role: "manager",
      accessResolved: true,
      canSeeTransactions: true,
      canSeeSettlements: true,
      canSeeBudgets: true,
      canPlan: true,
      canEditDocuments: true,
    };

    expect(getVisibleAdminDestinations(base).map((item) => item.href)).not.toContain("/settings/agencies");
    expect(getVisibleWorkspaces(base).map((item) => item.href)).not.toContain("/agencies");
    expect(getVisibleAdminDestinations({ ...base, canManageAgencies: true }).map((item) => item.href)).toContain("/settings/agencies");
    expect(getVisibleWorkspaces({ ...base, canManageAgencies: true }).map((item) => item.href)).toContain("/agencies");
  });

  it("labels restricted settings as the user's own account", () => {
    const viewer = {
      role: "viewer",
      accessResolved: true,
      canSeeTransactions: false,
      canSeeSettlements: false,
      canSeeBudgets: false,
      canPlan: false,
      canEditDocuments: false,
    };

    expect(getVisibleAdminDestinations(viewer)).toContainEqual(expect.objectContaining({
      href: "/settings",
      label: "My account",
    }));
    expect(getVisibleAdminDestinations({ ...viewer, role: "manager" })).toContainEqual(expect.objectContaining({
      href: "/settings",
      label: "Settings",
    }));
    expect(getVisibleAdminDestinations({ ...viewer, role: "admin" })).toContainEqual(expect.objectContaining({
      href: "/settings",
      label: "Users & settings",
    }));
  });
});
