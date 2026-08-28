import { describe, expect, it, vi } from "vitest";
import { createUser, userAccessConfigFromInput } from "@/lib/auth/users";
import { BUDGET_PLANNER_ACCESS } from "@/lib/auth/access-presets";
import type { PgLikePool } from "@/lib/import/commit";

describe("new user access defaults", () => {
  it("keeps the budget planner profile hours-only and outside financial operations", () => {
    expect(BUDGET_PLANNER_ACCESS).toMatchObject({
      accessScope: "full",
      canPlan: true,
      canSeeHours: true,
      canSeeBudgets: true,
      canSeeTransactions: false,
      canSeeMoney: false,
      canSeeBilledAmounts: false,
      canSeeEmployeeAmounts: false,
      canSeeAgencySpread: false,
      canSeeCheckNet: false,
      canSeeTaxes: false,
      canSeeEmployeeDeals: false,
      canSeeSettlements: false,
      canManageSettlements: false,
      canSeeClassFinancials: false,
      canManageClassInvoices: false,
      canEditDocuments: false,
    });
  });

  it("creates viewers with no implicit people, transaction, hours, or money access", () => {
    expect(userAccessConfigFromInput({}, "viewer")).toEqual({
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
      individualIds: [],
      employeeIds: [],
    });
  });

  it("honors permissions that an administrator explicitly grants to a viewer", () => {
    const config = userAccessConfigFromInput({
      accessScope: "scoped",
      canSeeTransactions: true,
      canSeeMoney: true,
      canSeeHours: true,
      canSeeBudgets: true,
      canSeeEmployeeDeals: true,
      canSeeSettlements: true,
      canManageSettlements: true,
      canSeeClassFinancials: true,
      canManageClassInvoices: true,
      canEditDocuments: true,
      canPlan: true,
      individualIds: ["individual-1"],
      employeeIds: ["employee-1"],
    }, "viewer");

    expect(config).toMatchObject({
      accessScope: "scoped",
      canSeeTransactions: true,
      canSeeMoney: true,
      canSeeHours: true,
      canSeeBudgets: true,
      canSeeEmployeeDeals: true,
      canSeeSettlements: true,
      canManageSettlements: true,
      canSeeClassFinancials: true,
      canManageClassInvoices: true,
      canEditDocuments: true,
      canPlan: true,
      individualIds: ["individual-1"],
      employeeIds: ["employee-1"],
    });
  });

  it("does not reinterpret stale full-scope staff flags as viewer grants", () => {
    expect(userAccessConfigFromInput({
      accessScope: "full",
      seeAllIndividuals: true,
      seeAllEmployees: true,
      canSeeTransactions: true,
      canSeeMoney: true,
      canSeeHours: true,
      canSeeBudgets: true,
      canSeeSettlements: true,
      canManageSettlements: true,
      individualIds: ["00000000-0000-4000-8000-000000000003"],
    }, "viewer")).toEqual(userAccessConfigFromInput({}, "viewer"));
  });

  it("does not grant budgets without the hours they are built from", () => {
    expect(userAccessConfigFromInput({
      canSeeBudgets: true,
      canSeeHours: false,
    }, "viewer")).toMatchObject({
      canSeeHours: false,
      canSeeBudgets: false,
    });
  });

  it("preserves the existing permissive defaults for trusted staff roles", () => {
    expect(userAccessConfigFromInput({}, "manager")).toMatchObject({
      accessScope: "full",
      canSeeTransactions: true,
      canSeeMoney: true,
      canSeeHours: true,
      canSeeBilledAmounts: true,
      canSeeEmployeeAmounts: true,
      canSeeAgencySpread: true,
      canSeeCheckNet: true,
      canSeeTaxes: true,
      canSeeBudgets: true,
      canSeeEmployeeDeals: false,
      canSeeSettlements: false,
      canManageSettlements: false,
      canSeeClassFinancials: true,
      canManageClassInvoices: true,
      canEditDocuments: true,
      canPlan: true,
    });
  });

  it("creates a viewer and its locked access in one transaction", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      if (sql.includes("FROM users") && sql.includes("WHERE email")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });
    const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      if (sql.includes("INSERT INTO users")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000001",
            email: "viewer@example.test",
            display_name: "Viewer",
            password_hash: "stored-hash",
            role: "viewer",
            is_active: true,
            last_login_at: null,
            created_at: "2026-08-24T00:00:00.000Z",
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const pool = {
      query,
      connect: vi.fn(async () => ({ query: clientQuery, release })),
    } as unknown as PgLikePool;

    const result = await createUser(pool, {
      email: "viewer@example.test",
      displayName: "Viewer",
      password: "a secure password",
      role: "viewer",
    }, "00000000-0000-4000-8000-000000000002");

    expect(result.ok).toBe(true);
    const insert = clientQuery.mock.calls.find(([sql]) => sql.includes("INSERT INTO users"));
    expect(insert?.[1]?.slice(4)).toEqual(["scoped", ...Array(15).fill(false)]);
    const accessUpdate = clientQuery.mock.calls.find(([sql]) => sql.includes("SET access_scope"));
    expect(accessUpdate?.[1]).toEqual([
      "scoped",
      ...Array(18).fill(false),
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(clientQuery.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});
