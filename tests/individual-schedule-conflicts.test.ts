import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { listIndividualScheduleConflicts } from "@/lib/data/individual-schedule-conflicts";

const INDIVIDUAL_ID = "10000000-0000-4000-8000-000000000001";
const SERIES_ID = "20000000-0000-4000-8000-000000000001";

describe("individual recurrence conflicts", () => {
  it("finds a selected-individual clash on a later occurrence", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          individual_id: INDIVIDUAL_ID,
          individual_name: "Ari Cohen",
          session_date: "2026-09-08",
          start_time: "10:00",
          end_time: "12:00",
        },
        {
          individual_id: INDIVIDUAL_ID,
          individual_name: "Ari Cohen",
          session_date: "2026-09-15",
          start_time: "13:00",
          end_time: "14:00",
        },
      ],
    }));
    const pool = { query } as unknown as PgLikePool;

    const result = await listIndividualScheduleConflicts(pool, {
      individualIds: [INDIVIDUAL_ID],
      sessionDates: ["2026-09-01", "2026-09-08", "2026-09-15"],
      startTime: "09:30",
      endTime: "11:30",
    });

    expect(result).toEqual({
      occurrenceCount: 3,
      individuals: [{
        individualId: INDIVIDUAL_ID,
        individualName: "Ari Cohen",
        conflictCount: 1,
        conflictingOccurrenceCount: 1,
        conflictingDates: ["2026-09-08"],
      }],
    });
  });

  it("excludes only replaceable rows from the edited series", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { rows: [] };
    });
    const pool = { query } as unknown as PgLikePool;

    await listIndividualScheduleConflicts(pool, {
      individualIds: [INDIVIDUAL_ID],
      sessionDates: ["2026-09-08"],
      startTime: "09:00",
      endTime: "11:00",
      excludeSeriesId: SERIES_ID,
      excludeSeriesFromDate: "2026-09-08",
    });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("session.series_id IS DISTINCT FROM $4::uuid");
    expect(sql).toContain("session.status <> 'pending'");
    expect(params).toEqual([
      [INDIVIDUAL_ID],
      ["2026-09-08"],
      null,
      SERIES_ID,
      "2026-09-08",
    ]);
  });

  it("never serializes transaction or financial metadata", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as PgLikePool;
    const result = await listIndividualScheduleConflicts(pool, {
      individualIds: [INDIVIDUAL_ID],
      sessionDates: ["2026-09-08"],
      startTime: "09:00",
      endTime: "11:00",
    });
    const serialized = JSON.stringify(result).toLowerCase();
    for (const forbidden of ["money", "amount", "rate", "transaction", "check", "pay"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
