import { describe, expect, it, vi } from "vitest";
import {
  archiveWeeklyAvailabilityWindow,
  createEmployeeUnavailabilityWindow,
  createWeeklyAvailabilityWindow,
  listEmployeeAvailabilityRules,
} from "@/lib/manage/employee-availability";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";

const EMPLOYEE_ID = "30000000-0000-4000-8000-000000000001";
const WINDOW_ID = "40000000-0000-4000-8000-000000000001";
const ACTOR_ID = "50000000-0000-4000-8000-000000000001";

const weeklyRow = (archivedAt: string | null = null) => ({
  id: WINDOW_ID,
  employee_id: EMPLOYEE_ID,
  employee_name: "Alice",
  weekday: 1,
  start_time: "09:00",
  end_time: "17:00",
  effective_from: "2026-09-01",
  effective_to: null,
  notes: "Normal hours",
  archived_at: archivedAt,
  created_at: "2026-08-31T12:00:00.000Z",
});

function poolWithClient(query: PgLikeClient["query"]): PgLikePool {
  const client = { query, release: vi.fn() } as PgLikeClient;
  return {
    query,
    connect: vi.fn(async () => client),
  } as PgLikePool;
}

describe("employee availability management", () => {
  it("creates a weekly window and records the mutation in the same transaction", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("SELECT id FROM employees")) return { rows: [{ id: EMPLOYEE_ID }] };
      if (sql.includes("SELECT id FROM employee_weekly_availability")) return { rows: [] };
      if (sql.includes("INSERT INTO employee_weekly_availability")) return { rows: [{ id: WINDOW_ID }] };
      if (sql.includes("JOIN employees employee")) return { rows: [weeklyRow()] };
      return { rows: [] };
    }) as PgLikeClient["query"];

    const result = await createWeeklyAvailabilityWindow(poolWithClient(query), {
      employeeId: EMPLOYEE_ID,
      weekday: 1,
      startTime: "09:00",
      endTime: "17:00",
      effectiveFrom: "2026-09-01",
      notes: " Normal hours ",
    }, ACTOR_ID, "Employee confirmed hours");

    expect(result).toEqual({ ok: true, data: expect.objectContaining({ id: WINDOW_ID, kind: "weekly" }) });
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.join("\n")).toContain("INSERT INTO audit_logs");
    const auditCall = vi.mocked(query).mock.calls.find(([sql]) => sql.includes("INSERT INTO audit_logs"));
    expect(auditCall?.[1]).toEqual([
      ACTOR_ID,
      "employee_weekly_availability_created",
      "employee_weekly_availability",
      WINDOW_ID,
      "Employee confirmed hours",
      expect.any(String),
    ]);
  });

  it("archives instead of deleting and audits the before and after state", async () => {
    let archived = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE employee_weekly_availability")) {
        archived = true;
        return { rows: [] };
      }
      if (sql.includes("JOIN employees employee")) {
        return { rows: [weeklyRow(archived ? "2026-08-31T13:00:00.000Z" : null)] };
      }
      return { rows: [] };
    }) as PgLikeClient["query"];

    const result = await archiveWeeklyAvailabilityWindow(
      poolWithClient(query),
      WINDOW_ID,
      ACTOR_ID,
      "Hours changed",
    );

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ archivedAt: "2026-08-31T13:00:00.000Z" }),
    });
    expect(vi.mocked(query).mock.calls.some(([sql]) => sql.includes("DELETE"))).toBe(false);
    const auditCall = vi.mocked(query).mock.calls.find(([sql]) => sql.includes("INSERT INTO audit_logs"));
    expect(auditCall?.[1]?.[1]).toBe("employee_weekly_availability_archived");
  });

  it("lists both rule types with one finance-free read model", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("employee_weekly_availability")
      ? { rows: [weeklyRow()] }
      : {
        rows: [{
          id: "40000000-0000-4000-8000-000000000002",
          employee_id: EMPLOYEE_ID,
          employee_name: "Alice",
          start_date: "2026-09-07",
          end_date: "2026-09-07",
          start_time: null,
          end_time: null,
          label: "Unavailable",
          archived_at: null,
          created_at: "2026-08-31T12:00:00.000Z",
        }],
      });

    const result = await listEmployeeAvailabilityRules(
      { query } as unknown as PgLikePool,
      { employeeId: EMPLOYEE_ID },
    );

    expect(result.weekly[0]).toMatchObject({ kind: "weekly", weekday: 1 });
    expect(result.unavailable[0]).toMatchObject({ kind: "unavailable", startDate: "2026-09-07" });
    expect(JSON.stringify(result).toLowerCase()).not.toMatch(/rate|amount|transaction|check|tax|payout/);
  });

  it("rejects ambiguous timed multi-day unavailability before opening a transaction", async () => {
    const pool = { connect: vi.fn() } as unknown as PgLikePool;
    const result = await createEmployeeUnavailabilityWindow(pool, {
      employeeId: EMPLOYEE_ID,
      startDate: "2026-09-01",
      endDate: "2026-09-03",
      startTime: "09:00",
      endTime: "10:00",
    }, ACTOR_ID);

    expect(result).toEqual({
      ok: false,
      code: "validation",
      message: "Timed unavailable entries must be for one day. Use full day for a date range.",
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
