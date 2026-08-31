import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { listUsersWithAccess } from "@/lib/auth/users";

function userRow(id: string, portal: {
  globalRoles: string[];
  agencyRoles?: string[];
  individual?: boolean;
  employee?: boolean;
}) {
  return {
    id,
    email: `${id}@example.test`,
    display_name: id,
    password_hash: "hash",
    role: portal.globalRoles.includes("owner") ? "admin" : "viewer",
    is_active: true,
    last_login_at: null,
    created_at: "2026-08-31T00:00:00Z",
    access_scope: "scoped",
    see_all_individuals: false,
    see_all_employees: false,
    can_see_transactions: false,
    can_see_money: false,
    can_see_hours: false,
    can_see_billed_amounts: false,
    can_see_employee_amounts: false,
    can_see_agency_spread: false,
    can_see_check_net: false,
    can_see_taxes: false,
    can_see_budgets: false,
    can_see_employee_deals: false,
    can_see_settlements: false,
    can_manage_settlements: false,
    can_see_class_financials: false,
    can_manage_class_invoices: false,
    can_edit_documents: false,
    can_plan: false,
    individual_count: 0,
    employee_count: 0,
    global_portal_roles: portal.globalRoles,
    agency_portal_roles: portal.agencyRoles ?? [],
    has_individual_relationship: portal.individual ?? false,
    has_employee_relationship: portal.employee ?? false,
  };
}

describe("portal-managed account summaries", () => {
  it("keeps a multi-role portal login out of the internal Custom editor", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          userRow("multi-portal", {
            globalRoles: ["employee"],
            agencyRoles: ["collector"],
            employee: true,
          }),
          userRow("owner-only", { globalRoles: ["owner"] }),
        ],
      })),
    } as unknown as PgLikePool;

    const users = await listUsersWithAccess(pool);
    expect(users.find((user) => user.id === "multi-portal")).toMatchObject({
      accountPreset: null,
      portalManaged: true,
    });
    expect(users.find((user) => user.id === "owner-only")).toMatchObject({
      accountPreset: "owner",
      portalManaged: false,
    });
  });
});
