import { describe, expect, it, vi } from "vitest";
import { fullAccess } from "@/lib/auth/access";
import {
  listDirectPayTargetFinancials,
  listPayrollChecks,
} from "@/lib/data/direct-pay-operations";
import { getEmployeeWithholding } from "@/lib/data/employee-queries";
import type { PgLikePool } from "@/lib/import/commit";

function poolWith(rows: unknown[]): PgLikePool {
  return {
    query: vi.fn(async () => ({ rows })),
    connect: vi.fn(),
  } as unknown as PgLikePool;
}

describe("direct-pay financial redaction", () => {
  it("does not query payroll-check facts when neither check detail grant is present", async () => {
    const pool = poolWith([]);
    const scope = {
      ...fullAccess("viewer-1", "viewer"),
      canSeeCheckNet: false,
      canSeeTaxes: false,
    };

    await expect(listPayrollChecks(pool, scope)).resolves.toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("removes gross and tax from the server DTO when only check net is granted", async () => {
    const pool = poolWith([{
      id: "check-1",
      employee_id: "employee-1",
      employee_name: "Employee One",
      check_number: "1001",
      check_date: "2026-08-15",
      period_begin: "2026-08-01",
      period_end: "2026-08-14",
      actual_gross: "1500",
      actual_net: "1200",
      tax_withheld: "300",
      source: "manual",
      source_ref: null,
      verification_status: "verified",
      notes: null,
      linked_transactions: "2",
      updated_at: "2026-08-15T00:00:00.000Z",
    }]);
    const scope = {
      ...fullAccess("viewer-1", "viewer"),
      canSeeCheckNet: true,
      canSeeTaxes: false,
    };

    const [check] = await listPayrollChecks(pool, scope);
    expect(check).toMatchObject({ actualGross: null, actualNet: "1200.0000", taxWithheld: null });
    expect(JSON.stringify(check)).not.toContain("1500.00");
    expect(JSON.stringify(check)).not.toContain("300.00");
  });

  it("keeps an exact-check drilldown inside the caller's employee scope", async () => {
    const pool = poolWith([]);
    const checkId = "123e4567-e89b-12d3-a456-426614174020";
    const employeeId = "123e4567-e89b-12d3-a456-426614174000";
    const scope = {
      ...fullAccess("viewer-1", "viewer"),
      full: false,
      allEmployees: false,
      grantedEmployeeIds: [employeeId],
      employeeIds: [employeeId],
      canSeeCheckNet: true,
      canSeeTaxes: false,
    };

    await listPayrollChecks(pool, scope, 100, checkId);

    const [sql, params] = vi.mocked(pool.query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("c.employee_id = ANY($1::uuid[])");
    expect(sql).toContain("c.id = $2::uuid");
    expect(sql).toContain("LIMIT $3");
    expect(params).toEqual([[employeeId], checkId, 100]);
  });

  it("lets an hours-only role see the derived target without target money", async () => {
    const pool = poolWith([{
      id: "target-1",
      employee_id: "employee-1",
      employee_name: "Employee One",
      target_basis: "gross",
      interval_unit: "week",
      interval_count: 1,
      gross_target_amount: "1000",
      planning_hourly_rate: "25",
      target_hours: "40",
      effective_from: "2026-08-01",
      effective_to: null,
      status: "active",
      notes: null,
    }]);
    const scope = {
      ...fullAccess("viewer-1", "viewer"),
      canSeeEmployeeAmounts: false,
      canSeeHours: true,
    };

    const [target] = await listDirectPayTargetFinancials(pool, scope);
    expect(target).toMatchObject({
      grossTargetAmount: null,
      planningHourlyRate: null,
      targetHours: "40.0000",
    });
    expect(JSON.stringify(target)).not.toContain("1000.00");
    expect(JSON.stringify(target)).not.toContain("25.00");
  });

  it("uses only verified checks for authoritative employee totals", async () => {
    const query = vi.fn(async (sql: string) => {
      void sql;
      return { rows: [{ withheld: "200", gross: "900", net: "700", gross_known_checks: "1", checks: "1" }] };
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await getEmployeeWithholding(pool, "00000000-0000-4000-8000-000000000001");

    expect(query.mock.calls[0]?.[0]).toContain("verification_status = 'verified'");
  });
});
