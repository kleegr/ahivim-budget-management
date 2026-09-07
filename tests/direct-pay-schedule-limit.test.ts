import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import {
  lockDirectPayTargetEmployees,
  projectDirectPayScheduleLimits,
} from "@/lib/data/direct-pay-schedule-limit";

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const TARGET_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const SERIES_ID = "40000000-0000-4000-8000-000000000001";

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    employee_id: EMPLOYEE_ID,
    employee_name: "Alice Employee",
    interval_unit: "week",
    interval_count: 1,
    target_hours: "10",
    effective_from: "2026-09-01",
    effective_to: null,
    ...overrides,
  };
}

function poolWith(rows: {
  targets?: ReturnType<typeof target>[];
  activity?: Array<{ window_key: string; recorded_hours: string; scheduled_hours: string }>;
}) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("FROM employee_direct_pay_targets")) return { rows: rows.targets ?? [] };
    if (sql.includes("WITH target_windows AS")) return { rows: rows.activity ?? [] };
    return { rows: [] };
  });
  return { pool: { query } as unknown as PgLikePool, query };
}

describe("Direct-Pay schedule limit projection", () => {
  it("takes target locks in stable employee order and deduplicates them", async () => {
    const otherEmployeeId = "10000000-0000-4000-8000-000000000002";
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const pool = { query } as unknown as PgLikePool;

    await lockDirectPayTargetEmployees(pool, [otherEmployeeId, EMPLOYEE_ID, null, otherEmployeeId]);

    expect(query.mock.calls.map(([, params]) => params)).toEqual([
      [EMPLOYEE_ID],
      [otherEmployeeId],
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("direct-pay-target:");
  });

  it("buckets recurring visits by the target window and identifies the first over-limit occurrence", async () => {
    const windowKey = `${TARGET_ID}:2026-09-01:2026-09-07`;
    const { pool } = poolWith({
      targets: [target()],
      activity: [{ window_key: windowKey, recorded_hours: "4", scheduled_hours: "2" }],
    });

    const rows = await projectDirectPayScheduleLimits(pool, {
      employeeId: EMPLOYEE_ID,
      occurrenceDates: ["2026-09-04", "2026-09-05", "2026-09-06"],
      occurrenceNumbers: {
        "2026-09-04": 2,
        "2026-09-05": 4,
        "2026-09-06": 6,
      },
      durationHours: "2",
      asOfDate: "2026-09-03",
    });

    expect(rows).toEqual([expect.objectContaining({
      targetId: TARGET_ID,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-07",
      targetHours: "10.0000",
      recordedHours: "4.0000",
      scheduledHours: "2.0000",
      candidateHours: "6.0000",
      projectedHours: "12.0000",
      overageHours: "2.0000",
      overLimit: true,
      crossingOccurrence: { occurrenceDate: "2026-09-06", occurrenceNumber: 6 },
    })]);
  });

  it("allows exact target coverage and counts group employee time once per occurrence", async () => {
    const windowKey = `${TARGET_ID}:2026-09-01:2026-09-07`;
    const { pool } = poolWith({
      targets: [target()],
      activity: [{ window_key: windowKey, recorded_hours: "4", scheduled_hours: "2" }],
    });

    const [row] = await projectDirectPayScheduleLimits(pool, {
      employeeId: EMPLOYEE_ID,
      occurrenceDates: ["2026-09-04", "2026-09-05"],
      durationHours: "2",
      asOfDate: "2026-09-03",
    });

    expect(row).toMatchObject({
      candidateOccurrenceCount: 2,
      candidateHours: "4.0000",
      projectedHours: "10.0000",
      overageHours: "0.0000",
      overLimit: false,
      crossingOccurrence: null,
    });
  });

  it("keeps distinct recurring target periods separate", async () => {
    const { pool } = poolWith({
      targets: [target()],
      activity: [
        { window_key: `${TARGET_ID}:2026-09-01:2026-09-07`, recorded_hours: "0", scheduled_hours: "0" },
        { window_key: `${TARGET_ID}:2026-09-08:2026-09-14`, recorded_hours: "0", scheduled_hours: "0" },
      ],
    });

    const rows = await projectDirectPayScheduleLimits(pool, {
      employeeId: EMPLOYEE_ID,
      occurrenceDates: ["2026-09-07", "2026-09-08"],
      durationHours: "2",
      asOfDate: "2026-09-03",
    });

    expect(rows.map((row) => [row.windowStart, row.windowEnd, row.candidateHours])).toEqual([
      ["2026-09-01", "2026-09-07", "2.0000"],
      ["2026-09-08", "2026-09-14", "2.0000"],
    ]);
  });

  it("routes persisted visits from Program configuration, includes past pending rows, and applies exact edit exclusions", async () => {
    const { pool, query } = poolWith({
      targets: [target()],
      activity: [],
    });

    await projectDirectPayScheduleLimits(pool, {
      employeeId: EMPLOYEE_ID,
      occurrenceDates: ["2026-09-07"],
      durationHours: "1",
      asOfDate: "2026-09-03",
      excludeSessionId: SESSION_ID,
      excludeSeriesId: SERIES_ID,
      excludeSeriesFromDate: "2026-09-05",
    });

    const [sql, params] = query.mock.calls.find(([statement]) =>
      String(statement).includes("WITH target_windows AS"))!;
    expect(sql).toContain("effective_payment_recipient(");
    expect(sql).toContain("payroll_row.payment_recipient");
    expect(sql).toContain("NULL::text, program.payment_recipient");
    expect(sql).not.toContain("payroll_row.employee_id = session.employee_id");
    expect(sql).not.toContain("payroll_row.program_id = session.program_id");
    expect(sql).not.toContain("<= session.session_date");
    expect(sql).toContain("sum(session.duration_hours)");
    expect(sql).not.toContain("scheduled_allocations");
    expect(sql).not.toContain("latest_program_routing AS");
    expect(sql).not.toContain("session.session_date >= $2::date");
    expect(sql).toContain("session.id <> $3::uuid");
    expect(sql).toContain("session.series_id IS DISTINCT FROM $4::uuid");
    expect(params?.slice(1)).toEqual([
      "2026-09-03",
      SESSION_ID,
      SERIES_ID,
      "2026-09-05",
    ]);
  });

  it("treats no active target as no limit and fails closed on invalid input", async () => {
    const { pool, query } = poolWith({ targets: [] });
    await expect(projectDirectPayScheduleLimits(pool, {
      employeeId: EMPLOYEE_ID,
      occurrenceDates: ["2026-09-07"],
      durationHours: "1",
      asOfDate: "2026-09-03",
    })).resolves.toEqual([]);
    expect(query).toHaveBeenCalledOnce();

    query.mockClear();
    await expect(projectDirectPayScheduleLimits(pool, {
      employeeId: EMPLOYEE_ID,
      occurrenceDates: ["2026-02-29"],
      durationHours: "1",
      asOfDate: "2026-09-03",
    })).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
