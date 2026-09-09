import { describe, expect, it } from "vitest";
import { buildMonthlyAuthorizationPlan, type MonthlyPlanInput } from "@/lib/business/monthly-authorization-plan";
import { dec } from "@/lib/money";
const input = (overrides: Partial<MonthlyPlanInput> = {}): MonthlyPlanInput => ({ startDate: "2026-06-01", endDate: "2026-08-31", renewalDate: "2026-09-01", asOf: "2026-07-01", authorizedHours: "240", actualHours: "60", history: [{ month: "2026-06", usedHours: "60", scheduledHours: "0" }, { month: "2026-08", usedHours: "0", scheduledHours: "50" }], ...overrides });
describe("one authorization's monthly working plan", () => {
  it("connects 60 historical hours with 180 remaining and 90 each across two equal full months", () => {
    const result = buildMonthlyAuthorizationPlan(input());
    expect(result.months.map((row) => [row.month, row.actualHours, row.targetHours, row.scheduledHours, row.gapHours])).toEqual([
      ["2026-06", "60", null, "0.00", null], ["2026-07", "0.00", "90.00", "0.00", "90.00"], ["2026-08", "0", "90.00", "50.00", "40.00"],
    ]);
    expect(result.remainingHours).toBe("180.00"); expect(result.remainingAfterSchedule).toBe("130.00");
  });
  it("weights the remaining part of the current month and reconciles rounded targets exactly", () => {
    const result = buildMonthlyAuthorizationPlan(input({ asOf: "2026-07-16", actualHours: "140", history: [] }));
    const current = result.months.find((row) => row.month === "2026-07")!;
    expect(current).toMatchObject({ phase: "current", remainingDays: 16, targetHours: "34.04" });
    expect(result.months.reduce((sum, row) => sum.plus(row.targetHours ?? 0), dec(0)).toFixed(2)).toBe("100.00");
  });
  it("stops before renewal and never turns an overrun into a negative target", () => {
    const result = buildMonthlyAuthorizationPlan(input({ renewalDate: "2026-08-15", actualHours: "260" }));
    expect(result.remainingHours).toBe("-20.00");
    expect(result.months.filter((row) => row.targetHours !== null).every((row) => row.targetHours === "0.00" && row.gapHours === "0.00")).toBe(true);
    expect(result.months.at(-1)?.remainingDays).toBe(14);
  });
  it.each([{ renewalDate: null }, { authorizedHours: null }, { actualHours: null }, { unavailableUsage: true }, { periodStatus: "closed" }, { asOf: "2026-09-01" }])("keeps targets unavailable when required setup or usable scope is absent: %j", (overrides) => {
    const result = buildMonthlyAuthorizationPlan(input(overrides));
    expect(result.unavailableReason).not.toBeNull(); expect(result.months.every((row) => row.targetHours === null && row.gapHours === null)).toBe(true);
  });
  it("never produces negative penny-sized targets across many months", () => {
    const result = buildMonthlyAuthorizationPlan(input({ startDate: "2026-01-01", asOf: "2026-01-01", endDate: "2026-12-31", renewalDate: "2027-01-01", authorizedHours: "0.04", actualHours: "0", history: [] }));
    expect(result.months.every((row) => dec(row.targetHours ?? 0).gte(0))).toBe(true);
    expect(result.months.reduce((sum, row) => sum.plus(row.targetHours ?? 0), dec(0)).toFixed(2)).toBe("0.04");
  });
});
