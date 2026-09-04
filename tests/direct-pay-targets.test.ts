import { describe, expect, it, vi } from "vitest";
import {
  directPayTargetProgress,
  directPayTargetWindow,
} from "@/lib/business/direct-pay-targets";
import type { PgLikePool } from "@/lib/import/commit";
import { archiveDirectPayTarget, saveDirectPayTarget } from "@/lib/manage/direct-pay-operations";
import { listPlannerDirectPayTargets } from "@/lib/data/direct-pay-operations";

const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";

describe("direct-pay target intervals", () => {
  it("anchors weekly intervals to the target effective date", () => {
    expect(directPayTargetWindow({
      intervalUnit: "week",
      intervalCount: 2,
      effectiveFrom: "2026-08-05",
      effectiveTo: null,
    }, "2026-08-24")).toEqual({
      startDate: "2026-08-19",
      endDate: "2026-09-01",
    });
  });

  it("uses calendar month groups and clamps the final interval", () => {
    expect(directPayTargetWindow({
      intervalUnit: "month",
      intervalCount: 2,
      effectiveFrom: "2026-01-15",
      effectiveTo: "2026-04-12",
    }, "2026-03-20")).toEqual({
      startDate: "2026-03-01",
      endDate: "2026-04-12",
    });
  });

  it("reports hours-only progress without exposing financial inputs", () => {
    expect(directPayTargetProgress({
      targetHours: "40",
      recordedHours: "24",
      scheduledHours: "10",
    })).toEqual({
      remainingHours: "6.0000",
      coverageHours: "34.0000",
      status: "needs_hours",
    });
    expect(directPayTargetProgress({
      targetHours: "40",
      recordedHours: "24",
      scheduledHours: "16",
    }).status).toBe("covered");
    expect(directPayTargetProgress({
      targetHours: "40",
      recordedHours: "40",
      scheduledHours: "0",
    }).status).toBe("met");
  });
});

describe("direct-pay target management", () => {
  it("rejects an overlapping active target before writing", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM employees")) return { rows: [{ id: EMPLOYEE_ID }] };
      if (sql.includes("FROM employee_direct_pay_targets")) return { rows: [{ id: TARGET_ID }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      query,
      connect: vi.fn(async () => client),
    } as unknown as PgLikePool;

    const result = await saveDirectPayTarget(pool, {
      employeeId: EMPLOYEE_ID,
      intervalUnit: "week",
      intervalCount: 1,
      grossTargetAmount: "1000",
      planningHourlyRate: "25",
      effectiveFrom: "2026-08-01",
    }, null);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO employee_direct_pay_targets"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns only hours and status to the planner read model", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: TARGET_ID,
        employee_id: EMPLOYEE_ID,
        employee_name: "Planner Employee",
        interval_unit: "week",
        interval_count: 1,
        target_hours: "40",
        effective_from: "2026-08-24",
        effective_to: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        target_id: TARGET_ID,
        recorded_hours: "24",
        scheduled_hours: "12",
      }] });
    const pool = { query } as unknown as PgLikePool;

    const rows = await listPlannerDirectPayTargets(pool, "2026-08-28");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      employeeName: "Planner Employee",
      targetHours: "40.0000",
      recordedHours: "24.0000",
      scheduledHours: "12.0000",
      remainingHours: "4.0000",
      status: "needs_hours",
    });
    expect(rows[0]).not.toHaveProperty("grossTargetAmount");
    expect(rows[0]).not.toHaveProperty("planningHourlyRate");
    const activitySql = String(query.mock.calls[1]?.[0]);
    expect(activitySql).toContain("effective_payment_recipient(");
    expect(activitySql).toContain("t.payment_recipient,");
    expect(activitySql).toContain("routing.payment_recipient,");
    expect(activitySql).not.toContain("t.payment_recipient = 'employee' OR");
    expect(activitySql).toContain("canonical_service_date(t.period_begin, t.check_date, t.period_end)");
    expect(activitySql).toContain(
      "canonical_service_date(t.period_begin, t.check_date, t.period_end) IS NOT NULL",
    );
    expect(activitySql).toContain(
      "canonical_service_date(t.period_begin, t.check_date, t.period_end) <= $2::date",
    );
    expect(activitySql.match(/canonical_service_date\(t\.period_begin, t\.check_date, t\.period_end\) <= \$2::date/g))
      .toHaveLength(2);
    expect(activitySql).toContain("s.session_date >= $2::date");
    expect(activitySql).not.toContain("t.created_at::date");
    expect(query.mock.calls[1]?.[1]).toEqual([
      expect.any(String),
      "2026-08-28",
    ]);
  });

  it("archives a target and its audit record in one transaction", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("SELECT * FROM employee_direct_pay_targets")) {
        return { rows: [{ id: TARGET_ID, employee_id: EMPLOYEE_ID, status: "active" }] };
      }
      if (sql.includes("UPDATE employee_direct_pay_targets")) return { rows: [{ id: TARGET_ID }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as PgLikePool;

    await expect(archiveDirectPayTarget(pool, TARGET_ID, null)).resolves.toEqual({
      ok: true,
      data: { id: TARGET_ID },
    });

    const updateIndex = statements.findIndex((sql) => sql.includes("UPDATE employee_direct_pay_targets"));
    const auditIndex = statements.findIndex((sql) => sql.includes("INSERT INTO audit_logs"));
    const commitIndex = statements.indexOf("COMMIT");
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(auditIndex).toBeGreaterThan(updateIndex);
    expect(commitIndex).toBeGreaterThan(auditIndex);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
