import { describe, expect, it, vi } from "vitest";
import { fullAccess, resolveAccessScope, type AccessScope } from "@/lib/auth/access";
import { canAccessClassIndividual } from "@/lib/auth/class-financial-access";
import { listClassBudgets } from "@/lib/data/class-invoices";
import type { PgLikePool } from "@/lib/import/commit";

const DIRECT = "00000000-0000-4000-8000-000000000001";
const CONNECTED = "00000000-0000-4000-8000-000000000002";

function viewerRow(canSeeMoney: boolean) {
  return {
    access_scope: "scoped",
    see_all_individuals: false,
    see_all_employees: false,
    can_see_transactions: false,
    can_see_money: canSeeMoney,
    can_see_hours: false,
    can_see_billed_amounts: false,
    can_see_employee_amounts: false,
    can_see_agency_spread: false,
    can_see_check_net: false,
    can_see_taxes: false,
    can_see_budgets: false,
    can_see_employee_deals: false,
    can_see_settlements: false,
    can_plan: false,
    can_see_class_financials: true,
    can_manage_class_invoices: true,
    can_edit_documents: false,
  };
}

function accessPool(canSeeMoney: boolean): PgLikePool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM users")) return { rows: [viewerRow(canSeeMoney)] };
    if (sql.includes("FROM user_individual_access")) return { rows: [{ individual_id: DIRECT }] };
    if (sql.includes("FROM user_employee_access")) return { rows: [] };
    if (sql.includes("WHERE individual_id = ANY")) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { query, connect: vi.fn() } as unknown as PgLikePool;
}

describe("class financial access", () => {
  it("requires the money master flag even when both class grants are stored", async () => {
    const denied = await resolveAccessScope(accessPool(false), { id: "viewer", role: "viewer" });
    expect(denied).toMatchObject({
      canSeeClassFinancials: false,
      canManageClassInvoices: false,
    });

    const granted = await resolveAccessScope(accessPool(true), { id: "viewer", role: "viewer" });
    expect(granted).toMatchObject({
      canSeeClassFinancials: true,
      canManageClassInvoices: true,
    });
  });

  it("uses direct individual grants and never an employee-connected navigation expansion", () => {
    const scope: AccessScope = {
      ...fullAccess("viewer", "viewer"),
      full: false,
      allIndividuals: false,
      individualIds: [DIRECT, CONNECTED],
      grantedIndividualIds: [DIRECT],
    };

    expect(canAccessClassIndividual(scope, DIRECT)).toBe(true);
    expect(canAccessClassIndividual(scope, CONNECTED)).toBe(false);
  });

  it("injects only direct grants into the class financial read query", async () => {
    const scope: AccessScope = {
      ...fullAccess("viewer", "viewer"),
      full: false,
      allIndividuals: false,
      individualIds: [DIRECT, CONNECTED],
      grantedIndividualIds: [DIRECT],
    };
    const query = vi.fn(async (...args: [string, unknown[]?]) => {
      void args;
      return { rows: [] };
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await expect(listClassBudgets(pool, scope)).resolves.toEqual([]);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("b.individual_id = ANY($1::uuid[])");
    expect(query.mock.calls[0]?.[1]).toEqual([[DIRECT]]);
    expect(query.mock.calls[0]?.[1]).not.toContainEqual([CONNECTED]);
  });
});
