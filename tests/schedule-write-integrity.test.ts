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
    sourceCandidateCount: 1,
    sourceAmbiguous: false,
  })),
}));

import { createSession, rescheduleSession } from "@/lib/manage/schedule";

const SESSION_ID = "40000000-0000-4000-8000-000000000001";
const INDIVIDUAL_ID = "20000000-0000-4000-8000-000000000001";
const PROGRAM_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "50000000-0000-4000-8000-000000000001";

function schedulePool(options: { failAudit?: boolean } = {}) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes("INSERT INTO audit_logs") && options.failAudit) {
      throw new Error("audit unavailable");
    }
    if (sql.includes("FROM scheduled_sessions WHERE id = $1 FOR UPDATE")) {
      return { rows: [{
        employee_id: null,
        program_id: PROGRAM_ID,
        session_date: "2026-09-08",
        start_time: "09:00",
        end_time: "10:00",
        duration_hours: "1.0000",
        matched_transaction_id: null,
      }] };
    }
    if (sql.includes("SELECT individual_id FROM scheduled_allocations WHERE")) {
      return { rows: [{ individual_id: INDIVIDUAL_ID }] };
    }
    if (sql.includes("FROM programs WHERE id")) {
      return { rows: [{
        is_active: true,
        name: "Community Habilitation",
        groups_allowed: true,
        one_to_one_required: false,
        max_group_size: null,
        allow_multiple_employees: true,
      }] };
    }
    if (sql.includes("FROM program_rate_schedules")) {
      return { rows: [{
        agency_rate: "25.0000",
        internal_rate: "20.0000",
        effective_from: "2026-01-01",
        effective_to: null,
      }] };
    }
    if (sql.includes("SELECT status, display_name FROM individuals")) {
      return { rows: [{ status: "active", display_name: "Person" }] };
    }
    if (sql.includes("FROM scheduled_allocations a")) return { rows: [] };
    if (sql.includes("effective_budget_authorizations_at")) {
      return { rows: [{ start_date: "2026-01-01", end_date: "2026-12-31" }] };
    }
    if (sql.includes("INSERT INTO scheduled_sessions")) return { rows: [{ id: SESSION_ID }] };
    return { rows: [] };
  }) as PgLikeClient["query"];
  const client = { query, release: vi.fn() } as PgLikeClient;
  const pool = { query, connect: vi.fn(async () => client) } as PgLikePool;
  return { pool, query: vi.mocked(query), client, statements };
}

describe("schedule write integrity", () => {
  it("uses clock time as the authoritative duration and audits before commit", async () => {
    const { pool, query, statements } = schedulePool();

    await expect(createSession(pool, {
      employeeId: null,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      sessionDate: "2026-09-08",
      startTime: "09:00",
      endTime: "10:00",
      durationHours: "9",
    }, ACTOR_ID)).resolves.toEqual({
      ok: true,
      data: { id: SESSION_ID, warnings: [] },
    });

    const insert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO scheduled_sessions"));
    expect(insert?.[1]?.[7]).toBe("1.0000");
    const auditIndex = statements.findIndex((sql) => sql.includes("INSERT INTO audit_logs"));
    expect(auditIndex).toBeGreaterThan(statements.findIndex((sql) => sql.includes("INSERT INTO scheduled_sessions")));
    expect(auditIndex).toBeLessThan(statements.indexOf("COMMIT"));
  });

  it("rolls the visit back when its required audit record cannot be written", async () => {
    const { pool, statements } = schedulePool({ failAudit: true });

    const result = await createSession(pool, {
      employeeId: null,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      sessionDate: "2026-09-08",
      startTime: "09:00",
      endTime: "10:00",
      durationHours: "1",
    }, ACTOR_ID);

    expect(result).toMatchObject({ ok: false, code: "validation" });
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("recomputes visit hours, effective rates, and every allocation when times change", async () => {
    const { pool, query } = schedulePool();

    await expect(rescheduleSession(pool, SESSION_ID, {
      sessionDate: "2026-09-09",
      startTime: "09:00",
      endTime: "12:30",
    }, ACTOR_ID, "Longer visit approved")).resolves.toEqual({
      ok: true,
      data: { id: SESSION_ID, warnings: [] },
    });

    const sessionUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE scheduled_sessions") && String(sql).includes("duration_hours"));
    expect(sessionUpdate?.[1]).toEqual([
      SESSION_ID,
      "2026-09-09",
      "09:00",
      "12:30",
      "3.5000",
      "25.0000",
      "87.5000",
      "70.0000",
      "17.5000",
      null,
    ]);
    const allocationUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE scheduled_allocations"));
    expect(allocationUpdate?.[1]).toEqual([
      SESSION_ID,
      "3.5000",
      "20.0000",
      "70.0000",
    ]);
  });

  it("rejects impossible reschedule dates before opening a transaction", async () => {
    const pool = { connect: vi.fn() } as unknown as PgLikePool;

    await expect(rescheduleSession(pool, SESSION_ID, {
      sessionDate: "2026-02-29",
    }, ACTOR_ID)).resolves.toEqual({
      ok: false,
      code: "validation",
      message: "Give a valid session date.",
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
