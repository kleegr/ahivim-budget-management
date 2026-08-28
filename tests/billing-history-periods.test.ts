import { describe, expect, it } from "vitest";
import {
  buildBillingHistoryPeriods,
  getIndividualPeriodActivity,
  type PeriodProgram,
  type PeriodProgramMonth,
  type PlannedPeriodProgram,
} from "@/lib/data/queries";

const planned: PlannedPeriodProgram[] = [
  { id: "respite", name: "Respite", code: "RESPITE" },
  { id: "day-hab", name: "Day Hab", code: "DAY_HAB" },
];

const billed: PeriodProgram[] = [
  { id: "day-hab", name: "Day Hab", code: "DAY_HAB", hours: "12", agency: "600", internal: "204" },
  { id: "comhab", name: "Community Habilitation", code: "COMHAB", hours: "8", agency: "200", internal: "168" },
];

const months: PeriodProgramMonth[] = [
  { month: "2026-02", programId: "day-hab", programName: "Day Hab", programCode: "DAY_HAB", hours: "12", agency: "600", internal: "204" },
  { month: "2026-08", programId: "comhab", programName: "Community Habilitation", programCode: "COMHAB", hours: "8", agency: "200", internal: "168" },
];

describe("billing history periods", () => {
  it("keeps calendar-year activity separate from the individual's renewal year", () => {
    const periods = buildBillingHistoryPeriods({
      renewalStart: "2026-07-15",
      renewalEnd: "2027-07-15",
      calendarStart: "2026-01-01",
      calendarEnd: "2027-01-01",
      plannedPrograms: planned,
      programsBilled: billed,
      byProgramMonth: months,
    });

    expect(periods.map((period) => period.key)).toEqual(["renewal", "calendar"]);
    expect(periods[0]?.byProgramMonth.map((row) => row.programId)).toEqual(["comhab"]);
    expect(periods[1]?.byProgramMonth.map((row) => row.programId)).toEqual(["day-hab"]);
    expect(periods[0]?.start).toBe("2026-07-15");
    expect(periods[1]?.start).toBe("2026-01-01");
  });

  it("includes planned programs with zero billing and preserves billed-not-planned programs", () => {
    const periods = buildBillingHistoryPeriods({
      renewalStart: "2026-07-15",
      renewalEnd: "2027-07-15",
      calendarStart: "2026-01-01",
      calendarEnd: "2027-01-01",
      plannedPrograms: planned,
      programsBilled: billed,
      byProgramMonth: months,
    });

    const renewal = periods.find((period) => period.key === "renewal");
    const calendar = periods.find((period) => period.key === "calendar");
    expect(renewal?.programs.map((program) => program.id)).toEqual(["respite", "comhab"]);
    expect(renewal?.programs[0]).toMatchObject({ id: "respite", hours: "0", agency: "0", internal: "0" });
    expect(calendar?.programs).toEqual([billed[0]]);
  });

  it("still returns a calendar-year history when no individual renewal is configured", () => {
    const periods = buildBillingHistoryPeriods({
      renewalStart: null,
      renewalEnd: null,
      calendarStart: "2026-01-01",
      calendarEnd: "2027-01-01",
      plannedPrograms: planned,
      programsBilled: [],
      byProgramMonth: [],
    });

    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ key: "calendar", start: "2026-01-01", end: "2027-01-01" });
    expect(periods[0]?.programs[0]).toMatchObject({ id: "day-hab", hours: "0" });
  });

  it("queries calendar programs and renewal programs through separate date windows", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };

    await getIndividualPeriodActivity(
      pool as never,
      "person-1",
      "2026-07-15",
      "2027-07-15",
      undefined,
      planned,
    );

    expect(calls).toHaveLength(5);
    for (const call of calls.slice(2)) {
      expect(call.sql).toContain("IN ('DAY_HAB','SUPP_GROUP_DAY_HAB')");
      expect(call.sql).toContain(
        "canonical_service_date(t.period_begin, t.check_date, t.period_end) >= $4::date",
      );
      expect(call.sql).toContain(
        "canonical_service_date(t.period_begin, t.check_date, t.period_end) < $5::date",
      );
      expect(call.sql).toContain(
        "canonical_service_date(t.period_begin, t.check_date, t.period_end) >= $2::date",
      );
      expect(call.sql).toContain(
        "canonical_service_date(t.period_begin, t.check_date, t.period_end) < $3::date",
      );
      expect(call.params.slice(0, 3)).toEqual(["person-1", "2026-07-15", "2027-07-15"]);
      expect(call.params[3]).toMatch(/^\d{4}-01-01$/);
      expect(call.params[4]).toMatch(/^\d{4}-01-01$/);
    }
    expect(calls[2]?.sql).toContain(
      "date_trunc('month', canonical_service_date(t.period_begin, t.check_date, t.period_end))",
    );
  });
});
