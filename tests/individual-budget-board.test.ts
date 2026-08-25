import { describe, expect, it } from "vitest";
import { listIndividualBudgetBoard } from "@/lib/data/queries";

describe("individual budget portfolio read model", () => {
  it("converts group-session internal money to used hours before every portfolio calculation", async () => {
    const capturedSql: string[] = [];
    const pool = {
      query: async (sql: string) => {
        capturedSql.push(sql);
        if (sql.includes("FROM program_rate_schedules")) {
          return {
            rows: [{
              program_id: "day-hab",
              effective_from: "2026-01-01",
              effective_to: "2026-12-31",
              internal_rate: "17",
              agency_rate: "19",
            }],
          };
        }
        return {
          rows: [{
            id: "person-1",
            display_name: "Ari Cohen",
            preferred_name: null,
            status: "active",
            archived_at: null,
            renewal_date: "2027-01-01",
            period_start: "2026-01-01",
            period_end: "2027-01-01",
            program_id: "day-hab",
            program_name: "Day Hab",
            program_code: "DAY_HAB",
            authorized_hours: "200",
            rate_override: null,
            rate_override_effective_from: null,
            billed_hours: "10",
            billed_internal: "1700",
            billed_amount: "2500",
            transaction_count: 2,
            has_billing: true,
            last_billed_on: "2026-08-20",
          }],
        };
      },
    };

    const asOf = new Date("2026-08-24T00:00:00.000Z");
    const [row] = await listIndividualBudgetBoard(pool as never, asOf);
    const budget = row?.budget;
    const daysToCalendarRenewal = Math.round(
      (Date.parse("2027-01-01T00:00:00Z") - asOf.getTime()) / (24 * 60 * 60 * 1000),
    );
    const expectedMonthly = 100 / (daysToCalendarRenewal / 30.4375);

    expect(budget?.usedHours).toBe(100);
    expect(budget?.hoursLeft).toBe(100);
    expect(budget?.usedPct).toBe(50);
    expect(budget?.mustUseMonthly).toBeCloseTo(expectedMonthly, 8);
    expect(budget?.billedAmount).toBe("2500.00");
    expect(capturedSql[0]).toContain("l.rate_override");
    expect(capturedSql[0]).toContain("t.period_begin < el.period_end");
    expect(capturedSql[0]).toContain("t.spreadsheet_internal_amount");
    expect(capturedSql[1]).toContain("FROM program_rate_schedules");
  });
});
