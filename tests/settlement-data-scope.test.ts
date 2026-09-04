import { describe, expect, it, vi } from "vitest";
import { fullAccess, type AccessScope } from "@/lib/auth/access";
import {
  getSettlementDashboard,
  settlementHistoryScopeWhere,
  withLiveIndividualPace,
} from "@/lib/data/settlements";
import type { PgLikePool } from "@/lib/import/commit";

const EMPLOYEE_GRANTED = "00000000-0000-4000-8000-000000000001";
const EMPLOYEE_CONNECTED = "00000000-0000-4000-8000-000000000002";
const INDIVIDUAL_GRANTED = "00000000-0000-4000-8000-000000000003";
const INDIVIDUAL_CONNECTED = "00000000-0000-4000-8000-000000000004";

function scoped(overrides: Partial<AccessScope> = {}): AccessScope {
  return {
    ...fullAccess("viewer-1", "viewer"),
    full: false,
    allIndividuals: false,
    allEmployees: false,
    individualIds: [],
    employeeIds: [],
    grantedIndividualIds: [],
    grantedEmployeeIds: [],
    ...overrides,
  };
}

describe("settlement history SQL scope", () => {
  it("uses an explicit employee grant without widening through connected people", () => {
    const params: unknown[] = [];
    const where = settlementHistoryScopeWhere(scoped({
      employeeIds: [EMPLOYEE_GRANTED, EMPLOYEE_CONNECTED],
      individualIds: [INDIVIDUAL_CONNECTED],
      grantedEmployeeIds: [EMPLOYEE_GRANTED],
    }), params);

    expect(where).toBe("WHERE (se.employee_id = ANY($1::uuid[]))");
    expect(params).toEqual([[EMPLOYEE_GRANTED]]);
    expect(params).not.toContainEqual([EMPLOYEE_CONNECTED]);
    expect(params).not.toContainEqual([INDIVIDUAL_CONNECTED]);
  });

  it("combines direct grants and supports all-person overrides", () => {
    const params: unknown[] = ["existing"];
    const where = settlementHistoryScopeWhere(scoped({
      allEmployees: true,
      grantedIndividualIds: [INDIVIDUAL_GRANTED],
    }), params);

    expect(where).toBe(
      "WHERE (se.employee_id IS NOT NULL OR se.individual_id = ANY($2::uuid[]))",
    );
    expect(params).toEqual(["existing", [INDIVIDUAL_GRANTED]]);
  });

  it("keeps full and absent scopes unchanged and denies an empty scoped viewer", () => {
    const fullParams: unknown[] = [];
    expect(settlementHistoryScopeWhere(fullAccess("admin-1", "admin"), fullParams)).toBe("");
    expect(fullParams).toEqual([]);

    const absentParams: unknown[] = [];
    expect(settlementHistoryScopeWhere(undefined, absentParams)).toBe("");
    expect(absentParams).toEqual([]);

    const emptyParams: unknown[] = [];
    expect(settlementHistoryScopeWhere(scoped(), emptyParams)).toBe("WHERE FALSE");
    expect(emptyParams).toEqual([]);
  });

  it("places the authorization predicate before ordering and does not truncate authorized history", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;
    const scope = scoped({ grantedEmployeeIds: [EMPLOYEE_GRANTED] });

    await getSettlementDashboard(pool, scope);

    const historyCall = query.mock.calls.find(([sql]) => String(sql).includes("SELECT se.id"));
    expect(historyCall).toBeDefined();
    const sql = String(historyCall?.[0]);
    expect(sql).toContain("WHERE (se.employee_id = ANY($1::uuid[]))");
    expect(sql.indexOf("WHERE (se.employee_id")).toBeLessThan(sql.indexOf("ORDER BY se.created_at"));
    expect(sql).not.toMatch(/LIMIT\s+250/i);
    expect(historyCall?.[1]).toEqual([[EMPLOYEE_GRANTED]]);
  });

  it("returns every accessible audit event instead of silently dropping older entries", async () => {
    const historyRows = Array.from({ length: 251 }, (_, index) => ({
      id: `event-${index}`,
      settlement_obligation_id: null,
      obligation_kind: null,
      check_number: null,
      check_date: null,
      period_begin: null,
      period_end: null,
      batch_action: null,
      paired_obligation_id: null,
      paired_obligation_kind: null,
      paired_check_number: null,
      paired_check_date: null,
      paired_period_begin: null,
      paired_period_end: null,
      employee_id: EMPLOYEE_GRANTED,
      individual_id: null,
      employee_name: "Employee One",
      individual_name: null,
      event_type: "payment",
      amount: "1.0000",
      occurred_on: "2026-08-01",
      reference: `REF-${index}`,
      note: null,
      actor_name: "owner@example.com",
      reversal_of_event_id: null,
      reversed_by_event_id: null,
      created_at: "2026-08-01T12:00:00.000Z",
    }));
    const query = vi.fn(async (sql: string) => (
      sql.includes("SELECT se.id") ? { rows: historyRows } : { rows: [] }
    ));
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const dashboard = await getSettlementDashboard(
      pool,
      scoped({ grantedEmployeeIds: [EMPLOYEE_GRANTED] }),
    );

    expect(dashboard.events).toHaveLength(251);
    expect(dashboard.events.at(-1)).toMatchObject({
      id: "event-250",
      personId: EMPLOYEE_GRANTED,
      reference: "REF-250",
    });
  });

  it("groups the same normalized check number used by ambiguous source ids", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await getSettlementDashboard(pool);

    const checkIssueCall = query.mock.calls.find(([sql]) => String(sql).includes("WITH direct_facts AS"));
    expect(checkIssueCall).toBeDefined();
    const sql = String(checkIssueCall?.[0]);
    expect(sql).toContain(
      "concat(employee_id::text, ':ambiguous-check:', NULLIF(btrim(check_number), '')) AS source_id",
    );
    expect(sql).toContain(
      "GROUP BY employee_id, employee_name, NULLIF(btrim(check_number), '')",
    );
    expect(sql).toContain("WHERE verified_payroll_check_id IS NULL");
    expect(sql.match(/effective_payment_recipient\(/g)).toHaveLength(4);
    expect(sql).toContain("p.payment_recipient");
    expect(sql).not.toContain("t.payment_recipient = 'employee'");
    expect(sql).toContain("LEFT JOIN employee_payroll_checks pc");
    expect(sql).toContain("pc.employee_id = t.employee_id");
    expect(sql).toContain("pc.verification_status = 'verified'");
    expect(sql).toContain("CASE WHEN pc.id IS NOT NULL THEN pc.actual_net ELSE t.total_net_pay END AS total_net_pay");
    expect(sql).toContain("CASE WHEN pc.id IS NOT NULL THEN pc.check_date ELSE t.check_date END AS check_date");
    expect(sql).toContain("count(verified_payroll_check_id) AS verified_check_count");
    expect(sql).toContain("concat(employee_id::text, ':payroll-check:', verified_payroll_check_id::text)");
    expect(sql).toContain("WHEN verified_check_count < row_count OR net_count = 0 THEN 'missing_net'");
    expect(sql).toContain("WHERE verified_check_count < row_count");
    expect(sql).toContain("AND pc.id IS NULL\n          AND (t.check_number IS NULL");

    const missingDealCall = query.mock.calls.find(([statement]) =>
      String(statement).includes("SELECT 1 FROM employee_deals d"),
    );
    const missingDealSql = String(missingDealCall?.[0]);
    expect(missingDealSql).toContain(
      "canonical_service_date(\n                 t.period_begin, t.check_date, t.period_end",
    );
    expect(missingDealSql).not.toContain("t.created_at::date");
  });

  it("redacts check gross independently from withholding and deductions", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT o.id, o.kind")) {
        return { rows: [{
          id: "obligation-1",
          kind: "direct_employee_collection",
          direction: "receivable",
          employee_id: EMPLOYEE_GRANTED,
          individual_id: null,
          employee_name: "Employee One",
          individual_name: null,
          original_amount: "100.0000",
          applied_amount: "0.0000",
          check_number: "CHK-1",
          check_date: "2026-08-21",
          period_begin: "2026-08-01",
          period_end: "2026-08-15",
          calculation_metadata: {
            flow: "direct_employee",
            checkGross: "1000.0000",
            taxWithheldDisplayOnly: "125.0000",
            totalDeductionsDisplayOnly: "200.0000",
          },
          status: "active",
          void_reason: null,
          transaction_count: "1",
          event_count: "0",
          last_action_at: null,
          created_at: "2026-08-21T12:00:00.000Z",
        }] };
      }
      return { rows: [] };
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const grossOnlyScope = {
      ...scoped({
        grantedEmployeeIds: [EMPLOYEE_GRANTED],
        canSeeTaxes: false,
      }),
      canSeeCheckGross: true,
    };
    const grossOnly = await getSettlementDashboard(pool, grossOnlyScope);
    expect(grossOnly.rows[0]?.calculation).toMatchObject({ checkGross: "1000.0000" });
    expect(grossOnly.rows[0]?.calculation).not.toHaveProperty("taxWithheldDisplayOnly");
    expect(grossOnly.rows[0]?.calculation).not.toHaveProperty("totalDeductionsDisplayOnly");

    const taxOnlyScope = {
      ...scoped({
        grantedEmployeeIds: [EMPLOYEE_GRANTED],
        canSeeTaxes: true,
      }),
      canSeeCheckGross: false,
    };
    const taxOnly = await getSettlementDashboard(pool, taxOnlyScope);
    expect(taxOnly.rows[0]?.calculation).not.toHaveProperty("checkGross");
    expect(taxOnly.rows[0]?.calculation).toMatchObject({
      taxWithheldDisplayOnly: "125.0000",
      totalDeductionsDisplayOnly: "200.0000",
    });
  });
});

describe("live settlement pace", () => {
  it("recomputes elapsed time and status from the read date", () => {
    const calculation = withLiveIndividualPace(
      {
        flow: "individual_plan",
        plannedHours: "100",
        actualHours: "80",
        timeElapsedPercent: "0.100000",
        paceStatus: "behind_pace",
      },
      "2026-01-01",
      "2026-12-31",
      new Date("2026-07-01T12:00:00Z"),
    );

    expect(calculation.timeElapsedPercent).toBe("0.498630");
    expect(calculation.paceStatus).toBe("ahead_of_pace");
  });
});
