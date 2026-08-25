import { describe, expect, it, vi } from "vitest";
import { getEmployeePlanningSummary } from "@/lib/data/employee-queries";
import type { PgLikePool } from "@/lib/import/commit";

const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000001";

describe("employee planner profile", () => {
  it("builds its summary from service and schedule hours without payroll or money fields", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM service_sessions")) {
        return { rows: [{ recorded_hours: "42.50", group_sessions: "3" }] };
      }
      if (sql.includes("FROM scheduled_sessions")) {
        return {
          rows: [{
            pending_hours: "12.00",
            pending_sessions: "2",
            completed_hours: "8.00",
            completed_sessions: "1",
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await expect(getEmployeePlanningSummary(pool, EMPLOYEE_ID)).resolves.toEqual({
      recordedServiceHours: "42.5000",
      groupSessions: 3,
      pendingHours: "12.0000",
      pendingSessions: 2,
      completedPlannedHours: "8.0000",
      completedPlannedSessions: 1,
    });

    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).not.toContain("payroll_transactions");
    expect(sql).not.toMatch(/amount|rate|check_number|payment/i);
  });
});
