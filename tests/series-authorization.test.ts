import { describe, expect, it, vi } from "vitest";
import { projectSeriesAuthorization } from "@/lib/data/series-authorization";
import type { PgLikePool } from "@/lib/import/commit";

const PROGRAM_ID = "10000000-0000-0000-0000-000000000001";
const INDIVIDUAL_ID = "20000000-0000-0000-0000-000000000001";
const FIRST_PERIOD_ID = "40000000-0000-0000-0000-000000000001";
const SECOND_PERIOD_ID = "40000000-0000-0000-0000-000000000002";
const EDITED_SERIES_ID = "50000000-0000-4000-8000-000000000001";

const personRows = [{ individual_id: INDIVIDUAL_ID, individual_name: "Ari Cohen" }];

describe("series authorization projection", () => {
  it("buckets visits and remaining hours into distinct renewal periods", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void params;
      return sql.includes("FROM individuals")
        ? { rows: personRows }
        : {
        rows: [
          {
            individual_id: INDIVIDUAL_ID,
            period_id: FIRST_PERIOD_ID,
            period_label: "Spring",
            start_date: "2026-01-01",
            end_date: "2026-06-30",
            authorized_hours: "100",
            actual_hours: "20",
            scheduled_hours: "5",
          },
          {
            individual_id: INDIVIDUAL_ID,
            period_id: SECOND_PERIOD_ID,
            period_label: "Renewal",
            start_date: "2026-07-01",
            end_date: "2026-12-31",
            authorized_hours: "120",
            actual_hours: "10",
            scheduled_hours: "10",
          },
        ],
      };
    });
    const pool = { query } as unknown as PgLikePool;

    const result = await projectSeriesAuthorization(pool, {
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      occurrenceDates: ["2026-06-01", "2026-06-08", "2026-07-06", "2026-07-13"],
      durationHours: "2.5",
      excludeSeriesId: EDITED_SERIES_ID,
      excludeSeriesFromDate: "2026-06-08",
    });

    expect(result.occurrenceCount).toBe(4);
    expect(result.individuals[0]).toEqual({
      individualId: INDIVIDUAL_ID,
      individualName: "Ari Cohen",
      periods: [
        {
          periodId: FIRST_PERIOD_ID,
          periodLabel: "Spring",
          startDate: "2026-01-01",
          endDate: "2026-06-30",
          authorizedHours: "100.0000",
          actualHours: "20.0000",
          scheduledHours: "5.0000",
          seriesOccurrenceCount: 2,
          seriesHours: "5.0000",
          remainingAfterHours: "70.0000",
          calculationSafe: true,
        },
        {
          periodId: SECOND_PERIOD_ID,
          periodLabel: "Renewal",
          startDate: "2026-07-01",
          endDate: "2026-12-31",
          authorizedHours: "120.0000",
          actualHours: "10.0000",
          scheduledHours: "10.0000",
          seriesOccurrenceCount: 2,
          seriesHours: "5.0000",
          remainingAfterHours: "95.0000",
          calculationSafe: true,
        },
      ],
      uncoveredOccurrenceCount: 0,
      uncoveredHours: "0.0000",
      ambiguousOccurrenceCount: 0,
      ambiguousHours: "0.0000",
      projectionSafe: true,
    });

    const serialized = JSON.stringify(result).toLowerCase();
    for (const forbidden of ["rate", "amount", "transaction", "check", "payout", "dollar"]) {
      expect(serialized).not.toContain(forbidden);
    }

    const sql = query.mock.calls.map(([statement]) => statement).join("\n").toLowerCase();
    for (const forbidden of ["expected_", "amount", "check", "payout"]) {
      expect(sql).not.toContain(forbidden);
    }
    expect(sql).toContain("s.matched_transaction_id is null");
    expect(sql).toContain("s.series_id is distinct from $5::uuid");
    const authorizationCall = query.mock.calls.find(([statement]) => statement.includes("effective_authorizations"));
    expect(authorizationCall?.[1]).toEqual([
      [INDIVIDUAL_ID],
      PROGRAM_ID,
      ["2026-06-01", "2026-06-08", "2026-07-06", "2026-07-13"],
      null,
      EDITED_SERIES_ID,
      "2026-06-08",
    ]);
  });

  it("separates authorization gaps and withholds balances for overlapping periods", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("FROM individuals")
      ? { rows: personRows }
      : {
        rows: [
          {
            individual_id: INDIVIDUAL_ID,
            period_id: FIRST_PERIOD_ID,
            period_label: "First",
            start_date: "2026-01-01",
            end_date: "2026-06-30",
            authorized_hours: "100",
            actual_hours: "10",
            scheduled_hours: "5",
          },
          {
            individual_id: INDIVIDUAL_ID,
            period_id: SECOND_PERIOD_ID,
            period_label: "Overlapping renewal",
            start_date: "2026-06-15",
            end_date: "2026-12-31",
            authorized_hours: "120",
            actual_hours: "12",
            scheduled_hours: "4",
          },
        ],
      });
    const pool = { query } as unknown as PgLikePool;

    const result = await projectSeriesAuthorization(pool, {
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      occurrenceDates: ["2026-06-01", "2026-06-22", "2026-07-06", "2027-01-04"],
      durationHours: "2",
    });

    const projection = result.individuals[0]!;
    expect(projection.uncoveredOccurrenceCount).toBe(1);
    expect(projection.uncoveredHours).toBe("2.0000");
    expect(projection.ambiguousOccurrenceCount).toBe(1);
    expect(projection.ambiguousHours).toBe("2.0000");
    expect(projection.projectionSafe).toBe(false);
    expect(projection.periods.every((period) =>
      period.actualHours === null && period.scheduledHours === null)).toBe(true);
    expect(projection.periods.map((period) => ({
      id: period.periodId,
      visits: period.seriesOccurrenceCount,
      hours: period.seriesHours,
      remaining: period.remainingAfterHours,
      safe: period.calculationSafe,
    }))).toEqual([
      { id: FIRST_PERIOD_ID, visits: 1, hours: "2.0000", remaining: null, safe: false },
      { id: SECOND_PERIOD_ID, visits: 1, hours: "2.0000", remaining: null, safe: false },
    ]);
  });
});
