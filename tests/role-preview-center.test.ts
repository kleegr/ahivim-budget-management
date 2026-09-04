import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_PRESETS,
  ACCOUNT_PRESET_IDS,
  type AccountPresetId,
} from "@/lib/auth/account-presets";
import { PORTAL_ONLY_ACCESS } from "@/lib/auth/access-presets";
import type { UserWithAccess } from "@/lib/auth/users";
import {
  buildRolePreviewAccounts,
  previewPresetForUser,
  ROLE_PREVIEW_DETAILS,
} from "@/lib/auth/role-preview";

function account(patch: Partial<UserWithAccess> = {}): UserWithAccess {
  return {
    id: "user-1",
    email: "user@example.test",
    displayName: "Test User",
    passwordHash: "not-returned-to-ui",
    role: "viewer",
    isActive: true,
    lastLoginAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    accessScope: "scoped",
    seeAllIndividuals: false,
    seeAllEmployees: false,
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
    canSeeClassFinancials: false,
    canManageClassInvoices: false,
    canEditDocuments: false,
    canPlan: false,
    individualCount: 0,
    employeeCount: 0,
    accountPreset: null,
    portalManaged: false,
    ...patch,
  };
}

function internalAccount(id: AccountPresetId, patch: Partial<UserWithAccess> = {}) {
  const preset = ACCOUNT_PRESETS.find((candidate) => candidate.id === id);
  if (!preset?.access) throw new Error(`${id} is not an internal access preset`);
  return account({
    ...preset.access,
    individualCount: preset.access.individualIds.length,
    employeeCount: preset.access.employeeIds.length,
    ...patch,
  });
}

describe("owner Role Preview Center", () => {
  it("documents every provisioning preset once with a landing page and privacy boundary", () => {
    expect(Object.keys(ROLE_PREVIEW_DETAILS)).toEqual(ACCOUNT_PRESET_IDS);
    for (const preset of ACCOUNT_PRESETS) {
      const details = ROLE_PREVIEW_DETAILS[preset.id];
      expect(details.landingHref, preset.id).toMatch(/^\//);
      expect(details.landingLabel.length, preset.id).toBeGreaterThan(2);
      expect(details.visible.length, preset.id).toBeGreaterThan(20);
      expect(details.hidden.length, preset.id).toBeGreaterThan(20);
    }
    expect(ROLE_PREVIEW_DETAILS).toMatchObject({
      owner: { landingHref: "/dashboard" },
      office_manager: { landingHref: "/dashboard" },
      budget_planner: { landingHref: "/home" },
      staffing_manager: { landingHref: "/home" },
      money_collector: { landingHref: "/home" },
      class_billing: { landingHref: "/home" },
      individual_parent: { landingHref: "/portal" },
      employee: { landingHref: "/portal" },
      agency: { landingHref: "/portal" },
      agency_scheduler: { landingHref: "/schedule" },
      agency_staffing_manager: { landingHref: "/schedule" },
      agency_collector: { landingHref: "/portal" },
      custom_access: { landingHref: "/home" },
    });
  });

  it("recognizes exact internal presets without confusing custom or portal-managed accounts", () => {
    for (const id of ["budget_planner", "staffing_manager", "money_collector", "class_billing"] as const) {
      expect(previewPresetForUser(internalAccount(id)), id).toBe(id);
    }
    expect(previewPresetForUser(internalAccount("budget_planner", { canSeeMoney: true }))).toBe("custom_access");
    expect(previewPresetForUser(internalAccount("budget_planner", {
      accountPreset: "budget_planner",
      canSeeMoney: true,
    }))).toBe("budget_planner");
    expect(previewPresetForUser(internalAccount("budget_planner", { portalManaged: true }))).toBeNull();
  });

  it("uses authoritative portal identities and the administrator role for external and owner cards", () => {
    expect(previewPresetForUser(account({
      ...PORTAL_ONLY_ACCESS,
      accountPreset: "employee",
      portalManaged: true,
    }))).toBe("employee");
    expect(previewPresetForUser(account({ role: "admin" }))).toBe("owner");
  });

  it("keeps only active matching accounts, prefers a usable recent representative, and carries linked scope", () => {
    const currentOwner = account({
      id: "owner-current",
      role: "admin",
      displayName: "Current Owner",
      lastLoginAt: "2026-09-04T12:00:00.000Z",
    });
    const olderOwner = account({
      id: "owner-other",
      role: "admin",
      displayName: "Other Owner",
      lastLoginAt: "2026-08-01T12:00:00.000Z",
    });
    const newestPlanner = internalAccount("budget_planner", {
      id: "planner-new",
      displayName: "New Planner",
      lastLoginAt: "2026-09-03T12:00:00.000Z",
    });
    const olderPlanner = internalAccount("budget_planner", {
      id: "planner-old",
      displayName: "Old Planner",
      lastLoginAt: "2026-08-03T12:00:00.000Z",
    });
    const disabledPlanner = internalAccount("budget_planner", {
      id: "planner-disabled",
      isActive: false,
    });
    const employee = account({
      ...PORTAL_ONLY_ACCESS,
      id: "employee-account",
      accountPreset: "employee",
      portalManaged: true,
    });

    const result = buildRolePreviewAccounts(
      [currentOwner, olderOwner, olderPlanner, newestPlanner, disabledPlanner, employee],
      currentOwner.id,
      {
        employeeNamesByUser: new Map([[employee.id, ["Linked Employee"]]]),
      },
    );

    expect(result.owner.map((item) => item.id)).toEqual(["owner-other", "owner-current"]);
    expect(result.budget_planner.map((item) => item.id)).toEqual(["planner-new", "planner-old"]);
    expect(result.employee[0]).toMatchObject({
      id: "employee-account",
      linkedEmployees: ["Linked Employee"],
      effectiveGrants: [],
    });
    expect(result.employee[0]?.effectiveDenials).toContain("Transactions");
    expect(result.budget_planner[0]?.effectiveGrants).toEqual(expect.arrayContaining([
      "All individuals",
      "All employees",
      "Service hours",
      "Budgets",
      "Schedule planning",
    ]));
    expect(result.budget_planner[0]?.effectiveDenials).toEqual(expect.arrayContaining([
      "Transactions",
      "Money workspaces",
      "Funder billed amounts",
    ]));
    expect(Object.values(result).flat().some((item) => item.id === "planner-disabled")).toBe(false);
  });

  it("reports trusted owner permissions as effective grants even when stored viewer flags are stale", () => {
    const result = buildRolePreviewAccounts([
      account({
        id: "owner",
        role: "admin",
        accessScope: "scoped",
        seeAllIndividuals: false,
        seeAllEmployees: false,
      }),
    ], "different-owner");

    expect(result.owner[0]?.effectiveGrants).toEqual(expect.arrayContaining([
      "All individuals",
      "All employees",
      "Transactions",
      "Money workspaces",
      "Schedule planning",
    ]));
    expect(result.owner[0]?.effectiveDenials).toEqual([]);
  });

  it("is guarded on the server and posts the selected real account through Sign In As", () => {
    const page = readFileSync("src/app/(app)/settings/role-preview/page.tsx", "utf8");
    const center = readFileSync("src/components/settings/role-preview-center.tsx", "utf8");
    const picker = readFileSync("src/components/settings/role-preview-account-picker.tsx", "utf8");

    expect(page).toContain('requireUser("admin")');
    expect(page).toContain("listUsersWithAccess(pool)");
    expect(center).toContain("ACCOUNT_PRESETS.map");
    expect(center).toContain("Preset intent — visible");
    expect(center).toContain("Preset intent — hidden");
    expect(picker).toContain('action="/api/auth/impersonation/start"');
    expect(picker).toContain('name="targetUserId"');
    expect(picker).toContain("Preview / Sign in as");
    expect(picker).toContain("not formal role acceptance");
    expect(picker).toContain("Not formally recorded");
    expect(picker).toContain("Selected account — effective internal access");
    expect(picker).toContain("Server-derived from this account");
    expect(picker).toContain('<p id={`${selectId}-label`} className="eyebrow">');
    expect(picker).toContain('aria-labelledby={`${selectId}-label`}');
  });
});
