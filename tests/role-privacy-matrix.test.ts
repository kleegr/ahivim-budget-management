import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_PRESETS,
  type AccountPresetId,
} from "@/lib/auth/account-presets";
import { fullAccess } from "@/lib/auth/access";
import {
  PORTAL_CAPABILITIES,
  portalCapabilitiesForRole,
  portalCapabilityAllowedForRole,
  type PortalCapability,
  type PortalRole,
} from "@/lib/auth/portal-access";

type InternalSurface =
  | "transactions"
  | "money"
  | "hours"
  | "budgets"
  | "billed"
  | "employeeAmounts"
  | "spread"
  | "checkNet"
  | "taxes"
  | "employeeDeals"
  | "settlements"
  | "manageSettlements"
  | "classFinancials"
  | "manageClassInvoices"
  | "documents"
  | "planning";

const INTERNAL_SURFACES: Record<InternalSurface, string> = {
  transactions: "canSeeTransactions",
  money: "canSeeMoney",
  hours: "canSeeHours",
  budgets: "canSeeBudgets",
  billed: "canSeeBilledAmounts",
  employeeAmounts: "canSeeEmployeeAmounts",
  spread: "canSeeAgencySpread",
  checkNet: "canSeeCheckNet",
  taxes: "canSeeTaxes",
  employeeDeals: "canSeeEmployeeDeals",
  settlements: "canSeeSettlements",
  manageSettlements: "canManageSettlements",
  classFinancials: "canSeeClassFinancials",
  manageClassInvoices: "canManageClassInvoices",
  documents: "canEditDocuments",
  planning: "canPlan",
};

const INTERNAL_ALLOW: Record<AccountPresetId, readonly InternalSurface[]> = {
  owner: Object.keys(INTERNAL_SURFACES) as InternalSurface[],
  budget_planner: ["hours", "budgets", "planning"],
  staffing_manager: ["hours", "planning"],
  money_collector: [
    "transactions",
    "money",
    "employeeAmounts",
    "checkNet",
    "taxes",
    "employeeDeals",
    "settlements",
    "manageSettlements",
  ],
  class_billing: ["money", "classFinancials", "manageClassInvoices", "documents"],
  individual_parent: [],
  employee: [],
  agency: [],
  agency_scheduler: [],
  agency_staffing_manager: [],
  agency_collector: [],
};

const PORTAL_ROLE_FOR_PRESET: Partial<Record<AccountPresetId, PortalRole>> = {
  owner: "owner",
  individual_parent: "parent",
  employee: "employee",
  agency: "agency",
  agency_scheduler: "scheduler",
  agency_staffing_manager: "staffing_manager",
  agency_collector: "collector",
};

const MONEY_CAPABILITY = /^(?:dollar_budgets|transactions|employee_pay|employee_checks|employee_giveback|financials|settlements)\./;

function preset(id: AccountPresetId) {
  const found = ACCOUNT_PRESETS.find((item) => item.id === id);
  if (!found) throw new Error(`Missing account preset: ${id}`);
  return found;
}

function internalAccess(id: AccountPresetId): Record<string, unknown> {
  const definition = preset(id);
  return definition.role === "viewer"
    ? (definition.access as unknown as Record<string, unknown>)
    : (fullAccess("matrix-user", definition.role) as unknown as Record<string, unknown>);
}

function routeFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return routeFiles(target);
    return entry.isFile() && entry.name === "route.ts" ? [target] : [];
  });
}

describe("preset role privacy matrix", () => {
  it("grants only the named internal data categories for every preset", () => {
    for (const definition of ACCOUNT_PRESETS) {
      const access = internalAccess(definition.id);
      const allowed = new Set(INTERNAL_ALLOW[definition.id]);
      for (const [surface, property] of Object.entries(INTERNAL_SURFACES) as Array<[InternalSurface, string]>) {
        expect(Boolean(access[property]), `${definition.label}: ${surface}`).toBe(allowed.has(surface));
      }
    }
  });

  it("keeps every external portal preset outside all internal people and ledger scopes", () => {
    for (const id of [
      "individual_parent",
      "employee",
      "agency",
      "agency_scheduler",
      "agency_staffing_manager",
      "agency_collector",
    ] as const) {
      const access = preset(id).access!;
      expect(access.accessScope, id).toBe("scoped");
      expect(access.seeAllIndividuals, id).toBe(false);
      expect(access.seeAllEmployees, id).toBe(false);
      expect(access.individualIds, id).toEqual([]);
      expect(access.employeeIds, id).toEqual([]);
      expect(Object.values(INTERNAL_SURFACES).every((property) =>
        !Boolean((access as unknown as Record<string, unknown>)[property])), id).toBe(true);
    }
  });

  it("keeps scheduler and staffing portals categorically money-free", () => {
    for (const role of ["scheduler", "staffing_manager"] as const) {
      const capabilities = portalCapabilitiesForRole(role);
      expect(capabilities.some((capability) => MONEY_CAPABILITY.test(capability)), role).toBe(false);
      for (const capability of PORTAL_CAPABILITIES.filter((item) => MONEY_CAPABILITY.test(item))) {
        expect(portalCapabilityAllowedForRole(role, capability), `${role}: ${capability}`).toBe(false);
      }
    }
  });

  it("binds each portal preset to the intended capability family", () => {
    const required: Partial<Record<AccountPresetId, readonly PortalCapability[]>> = {
      owner: PORTAL_CAPABILITIES,
      individual_parent: ["people.self.read", "hours_budgets.self.read"],
      employee: [
        "people.self.read",
        "employee_pay.self.read",
        "employee_checks.self.gross.read",
        "employee_checks.self.net.read",
        "employee_checks.self.tax.read",
        "employee_giveback.self.read",
      ],
      agency: ["agencies.read", "people.agency.read", "hours_budgets.agency.read"],
      agency_scheduler: ["agencies.read", "hours_budgets.agency.read", "schedules.agency.manage"],
      agency_staffing_manager: ["assignments.agency.manage", "schedules.agency.manage"],
      agency_collector: ["financials.agency.cuts_set_asides.read", "settlements.agency.read"],
    };

    for (const [id, role] of Object.entries(PORTAL_ROLE_FOR_PRESET) as Array<[AccountPresetId, PortalRole]>) {
      const capabilities = portalCapabilitiesForRole(role);
      for (const capability of required[id] ?? []) {
        expect(capabilities, `${id}: ${capability}`).toContain(capability);
      }
    }
    expect(preset("individual_parent").binding).toMatchObject({
      kind: "individual",
      defaultCapabilityGrants: [
        "financials.self.billed_totals.read",
        "financials.self.cuts_set_asides.read",
      ],
    });
  });
});

describe("protected API route inventory", () => {
  it("does not rely on the cookie-presence middleware as its server authorization", () => {
    const apiRoot = path.join(process.cwd(), "src", "app", "api");
    const intentionallyPublic = new Set([
      "auth/login/route.ts",
      "auth/logout/route.ts",
      "documents/uploads/route.ts",
      "health/db/route.ts",
      "health/env/route.ts",
      "health/schema/route.ts",
      "health/xlsx/route.ts",
      "sync/bootstrap/route.ts",
      "sync/cron/route.ts",
    ]);
    const serverGuard = /(?:apiUser|currentUser|currentSession|apiPortalUser|apiPlanningUser|apiClassFinancialUser|apiDocumentEditorUser|getSettlementOperator|getHourAuthorizationOperator|accessibleClassInvoice|accessibleDocument)\s*\(/;
    const files = routeFiles(apiRoot);

    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const relative = path.relative(apiRoot, file).replaceAll("\\", "/");
      if (intentionallyPublic.has(relative)) continue;
      expect(readFileSync(file, "utf8"), relative).toMatch(serverGuard);
    }
  });

  it("keeps anonymous bootstrap responses free of ledger totals and sync details", () => {
    const source = readFileSync(path.join(
      process.cwd(), "src", "app", "api", "sync", "bootstrap", "route.ts",
    ), "utf8");
    expect(source).toContain("isAdmin ? await verification(pool) : {}");
    expect(source).toContain("isAdmin ? { summary, ...(await verification(pool)) } : {}");
  });

  it("keeps anonymous cron responses free of monetary reconciliation details", () => {
    const source = readFileSync(path.join(
      process.cwd(), "src", "app", "api", "sync", "cron", "route.ts",
    ), "utf8");
    expect(source).toContain("detailed: false");
    expect(source).toContain("authorization.detailed ? { summary } : {}");
  });
});
