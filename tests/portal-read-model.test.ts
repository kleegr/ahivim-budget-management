import { describe, expect, it, vi } from "vitest";
import { agencyMonth } from "@/lib/business/agency-time";
import { getPortalHomeReadModel, normalizePortalMonth } from "@/lib/data/portal-read-model";
import type { PortalAccessContext } from "@/lib/auth/portal-access";
import type { PgLikePool } from "@/lib/import/commit";

const AGENCY_A = "00000000-0000-4000-8000-000000000001";
const AGENCY_B = "00000000-0000-4000-8000-000000000002";
const INDIVIDUAL = "00000000-0000-4000-8000-000000000003";

describe("portal-safe home read model", () => {
  it("returns aggregates only and hides budget counts from a collector-only agency", async () => {
    const context: PortalAccessContext = {
      userId: "user",
      globalRoles: [{ role: "parent", grants: [], denials: [] }],
      individualLinks: [{
        individualId: INDIVIDUAL,
        relationship: "guardian",
        grants: [
          "financials.self.billed_totals.read",
          "financials.self.direct_checks.read",
          "financials.self.agency_paid.read",
        ],
        denials: [],
      }],
      employeeLinks: [],
      agencyAccess: [
        {
          agencyId: AGENCY_A,
          agencyCode: "A",
          agencyName: "Agency A",
          role: "collector",
          grants: [],
          denials: [],
        },
        {
          agencyId: AGENCY_B,
          agencyCode: "B",
          agencyName: "Agency B",
          role: "scheduler",
          grants: [],
          denials: [],
        },
      ],
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      if (sql.includes("FROM individuals")) {
        return { rows: [{ id: INDIVIDUAL, name: "Authorized Child" }] };
      }
      if (sql.includes("FROM program_budget_balances")) {
        return { rows: [{
          scope_id: INDIVIDUAL,
          authorized_hours: "120",
          used_hours: "42",
          remaining_hours: "78",
          authorized_dollars: "2400",
          used_dollars: "840",
          remaining_dollars: "1560",
        }] };
      }
      if (sql.includes("FROM payroll_transactions")) {
        return { rows: [{ scope_id: INDIVIDUAL, amount: "250" }] };
      }
      if (sql.includes("FROM agencies a")) {
        return { rows: [
          {
            id: AGENCY_A,
            code: "A",
            name: "Agency A",
            individual_count: 12,
            employee_count: 8,
            managed_budget_count: 9,
            billing_without_budget_count: 3,
          },
          {
            id: AGENCY_B,
            code: "B",
            name: "Agency B",
            individual_count: 7,
            employee_count: 4,
            managed_budget_count: 5,
            billing_without_budget_count: 2,
          },
        ] };
      }
      if (sql.includes("FROM agency_individuals membership") && sql.includes("program_budget_balances")) {
        return { rows: [{
          scope_id: AGENCY_B,
          authorized_hours: "700",
          used_hours: "300",
          remaining_hours: "400",
          authorized_dollars: null,
          used_dollars: "0",
          remaining_dollars: null,
        }] };
      }
      if (sql.includes("FROM unnest")) {
        return { rows: [{
          scope_id: AGENCY_A,
          billed_this_month: null,
          set_aside_this_month: "125",
          agency_paid_this_month: "400",
          payroll_gross_this_month: "1500",
          payroll_net_this_month: "1200",
          giveback_remaining: "75",
        }] };
      }
      throw new Error(`Unexpected portal query: ${sql}`);
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const model = await getPortalHomeReadModel(pool, context, "2026-05");

    expect(model.month).toBe("2026-05");
    expect(model.directProfiles).toEqual({ individualCount: 1, employeeCount: 0 });
    expect(model.individuals[0]).toMatchObject({
      id: INDIVIDUAL,
      name: "Authorized Child",
      hours: { authorized: "120.0000", used: "42.0000", remaining: "78.0000" },
      dollars: null,
      billedThisMonth: "250.0000",
      setAsideThisMonth: null,
      directChecksThisMonth: "250.0000",
      agencyPaidThisMonth: "250.0000",
    });
    expect(model.agencies[0]).toMatchObject({
      id: AGENCY_A,
      individualCount: 12,
      employeeCount: 8,
      managedBudgetCount: null,
      billingWithoutBudgetCount: null,
    });
    expect(model.agencies[1]).toMatchObject({
      id: AGENCY_B,
      managedBudgetCount: 5,
      billingWithoutBudgetCount: 2,
      budgetHours: { authorized: "700.0000", used: "300.0000", remaining: "400.0000" },
    });
    expect(JSON.stringify(model)).not.toMatch(/employeeName|taxWithheld|connected/i);
    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).not.toMatch(/service_allocations|assignments/i);
    const agencyBudgetSql = query.mock.calls.find(([statement]) => statement.includes("LEFT JOIN program_budget_balances"))?.[0];
    const agencyFinancialCall = query.mock.calls.find(([statement]) => statement.includes("FROM unnest"));
    const directBilledCall = query.mock.calls.find(([statement]) => statement.includes("FROM payroll_transactions"));
    const portalSql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(agencyBudgetSql).toContain("membership.manages_budget = true");
    expect(agencyFinancialCall?.[0].match(/membership\.bills_services = true/g)).toHaveLength(2);
    expect(agencyFinancialCall?.[0]).toContain("membership.manages_budget = true");
    expect(agencyFinancialCall?.[0]).toContain("membership.effective_from <= canonical_service_date(");
    expect(agencyFinancialCall?.[0]).toContain("membership.effective_from <= event.occurred_on");
    expect(agencyFinancialCall?.[0]).toContain("transaction.period_begin, transaction.check_date, transaction.period_end");
    expect(agencyFinancialCall?.[0]).toContain("checks.period_begin, checks.check_date, checks.period_end");
    expect(agencyFinancialCall?.[0]).toContain("obligation.period_begin, obligation.check_date, obligation.period_end");
    expect(agencyFinancialCall?.[0]).toContain("checks.verification_status = 'verified'");
    expect(agencyFinancialCall?.[0]).not.toContain("checks.verification_status <> 'void'");
    expect(agencyFinancialCall?.[0].match(/AND EXISTS \(/g)?.length).toBeGreaterThanOrEqual(6);
    expect(agencyFinancialCall?.[0]).not.toMatch(/JOIN agency_(?:individuals|employees) membership/);
    expect(portalSql.match(/effective_payment_recipient\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(portalSql).not.toMatch(/\btransaction\.payment_recipient\s*=\s*'(?:employee|excellent_staffing)'/);
    expect(portalSql).not.toContain("created_at::date");
    expect(portalSql.match(/canonical_service_date\(/g)?.length).toBeGreaterThanOrEqual(12);
    expect(portalSql).toContain("AT TIME ZONE 'America/New_York'");
    expect(agencyFinancialCall?.[1]?.[6]).toBe("2026-05-01");
    expect(directBilledCall?.[1]?.[1]).toBe("2026-05-01");
  });

  it("accepts only a real YYYY-MM reporting month", () => {
    expect(normalizePortalMonth("2025-12")).toBe("2025-12");
    expect(normalizePortalMonth("2025-13")).toBe(agencyMonth());
    expect(normalizePortalMonth("0000-01")).toBe(agencyMonth());
    expect(normalizePortalMonth("not-a-month")).toBe(agencyMonth());
  });
});
