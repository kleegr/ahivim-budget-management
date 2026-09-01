import { describe, expect, it, vi } from "vitest";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";

vi.mock("@/lib/data/schedule-queries", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/data/schedule-queries")>(),
  individualProgramForecast: vi.fn(async () => ({
    actualHours: "0.0000",
    scheduledHours: "0.0000",
    remainingAfterScheduleHours: "100.0000",
    authorizedHours: "100.0000",
    authorizationCount: 1,
    authorizationAmbiguous: false,
  })),
}));

import {
  createSession,
  detectConflicts,
  SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
} from "@/lib/manage/schedule";
import { listSessionWarningFlags } from "@/lib/data/schedule-queries";

const EMPLOYEE_ID = "30000000-0000-4000-8000-000000000001";
const INDIVIDUAL_ID = "20000000-0000-4000-8000-000000000001";
const PROGRAM_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "40000000-0000-4000-8000-000000000001";
const ACTOR_ID = "50000000-0000-4000-8000-000000000001";

function availabilityQuery(statements: string[]) {
  return vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes("FROM programs WHERE id")) {
      return {
        rows: [{
          is_active: true,
          name: "Com Hab",
          groups_allowed: true,
          one_to_one_required: false,
          max_group_size: null,
          allow_multiple_employees: true,
        }],
      };
    }
    if (sql.includes("FROM program_rate_schedules")) {
      return {
        rows: [{
          agency_rate: "25.0000",
          internal_rate: "21.0000",
          effective_from: "2026-01-01",
          effective_to: null,
        }],
      };
    }
    if (sql.includes("SELECT status, display_name FROM employees")) {
      return { rows: [{ status: "active", display_name: "Alice" }] };
    }
    if (sql.includes("SELECT id AS employee_id")) {
      return { rows: [{ employee_id: EMPLOYEE_ID, employee_name: "Alice" }] };
    }
    if (sql.includes("SELECT employee_id, individual_id") && sql.includes("FROM assignments")) {
      return {
        rows: [{
          employee_id: EMPLOYEE_ID,
          individual_id: INDIVIDUAL_ID,
          start_date: null,
          end_date: null,
        }],
      };
    }
    if (sql.includes("FROM employee_weekly_availability")) {
      return {
        rows: [{
          employee_id: EMPLOYEE_ID,
          weekday: 1,
          start_time: "10:00",
          end_time: "17:00",
          effective_from: "2026-01-01",
          effective_to: null,
        }],
      };
    }
    if (sql.includes("FROM employee_unavailability")) {
      return {
        rows: [{
          employee_id: EMPLOYEE_ID,
          start_date: "2026-09-07",
          end_date: "2026-09-07",
          start_time: null,
          end_time: null,
        }],
      };
    }
    if (sql.includes("FROM scheduled_sessions")) return { rows: [] };
    if (sql.includes("SELECT status, display_name FROM individuals")) {
      return { rows: [{ status: "active", display_name: "Ari" }] };
    }
    if (sql.includes("FROM scheduled_allocations")) return { rows: [] };
    if (sql.includes("SELECT 1 FROM assignments")) return { rows: [{ assigned: 1 }] };
    if (sql.includes("effective_budget_authorizations_at")) {
      return { rows: [{ start_date: "2026-01-01", end_date: "2026-12-31" }] };
    }
    if (sql.includes("INSERT INTO scheduled_sessions")) return { rows: [{ id: SESSION_ID }] };
    return { rows: [] };
  });
}

function testPool(query: ReturnType<typeof availabilityQuery>): PgLikePool {
  const client = { query, release: vi.fn() } as unknown as PgLikeClient;
  return {
    query,
    connect: vi.fn(async () => client),
  } as unknown as PgLikePool;
}

const draft = {
  employeeId: EMPLOYEE_ID,
  programId: PROGRAM_ID,
  individualIds: [INDIVIDUAL_ID],
  sessionDate: "2026-09-07",
  startTime: "09:00",
  endTime: "10:00",
  durationHours: "1",
};

describe("save-time employee availability", () => {
  it("uses the same evaluator as preview for working hours and time off", async () => {
    const statements: string[] = [];
    const warnings = await detectConflicts(testPool(availabilityQuery(statements)), draft);

    expect(warnings).toEqual(expect.arrayContaining([
      {
        code: "employee_unavailable",
        severity: "warning",
        message: "This employee is marked unavailable at this time.",
      },
      {
        code: "employee_outside_working_hours",
        severity: "warning",
        message: "This session is outside the employee's working hours.",
      },
    ]));
  });

  it("locks and rechecks current availability before saving, then requires an override", async () => {
    const statements: string[] = [];
    const result = await createSession(testPool(availabilityQuery(statements)), draft, ACTOR_ID);

    expect(result).toEqual({
      ok: false,
      code: "validation",
      message: SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
    });
    const lockIndex = statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
    const hoursIndex = statements.findIndex((sql) => sql.includes("FROM employee_weekly_availability"));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(hoursIndex).toBeGreaterThan(lockIndex);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("keeps newly-entered time off visible as a live warning on an existing session", async () => {
    let statement = "";
    const pool = {
      query: vi.fn(async (sql: string) => {
        statement = sql;
        return {
          rows: [{
            id: SESSION_ID,
            warnings: [],
            has_conflict: false,
            has_availability_conflict: true,
            has_budget_risk: false,
            has_assignment_gap: false,
          }],
        };
      }),
    } as unknown as PgLikePool;

    const result = await listSessionWarningFlags(pool, {
      from: "2026-09-07",
      to: "2026-09-07",
      employeeId: EMPLOYEE_ID,
    });

    expect(statement).toContain("FROM employee_unavailability unavailable");
    expect(result).toEqual([{
      id: SESSION_ID,
      hasConflict: true,
      hasBudgetRisk: false,
      warningCount: 1,
    }]);
  });
});
