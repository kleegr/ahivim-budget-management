import { describe, expect, it } from "vitest";
import { calculatePlanningCoverage } from "@/lib/business/planning";
import { dec } from "@/lib/money";

const PERIOD = { startDate: "2025-01-01", endDate: "2025-12-31" };

describe("planning coverage", () => {
  it("separates actual pace from coverage supplied by pending sessions", () => {
    const result = calculatePlanningCoverage({
      ...PERIOD,
      authorizedHours: "100",
      actualHours: "35",
      scheduledHours: "20",
      asOf: new Date("2025-07-02T00:00:00Z"),
    });

    expect(result.status).toBe("covered");
    expect(dec(result.unplannedHours).toNumber()).toBe(45);
    expect(dec(result.targetToDateHours).toNumber()).toBeCloseTo(50.14, 1);
    expect(dec(result.requiredWeeklyHours).toNumber()).toBeGreaterThan(1);
  });

  it("marks a current plan gap and an over-committed authorization", () => {
    const gap = calculatePlanningCoverage({
      ...PERIOD,
      authorizedHours: "100",
      actualHours: "10",
      scheduledHours: "10",
      asOf: new Date("2025-07-02T00:00:00Z"),
    });
    expect(gap.status).toBe("plan_gap");

    const over = calculatePlanningCoverage({
      ...PERIOD,
      authorizedHours: "100",
      actualHours: "80",
      scheduledHours: "25",
      asOf: new Date("2025-07-02T00:00:00Z"),
    });
    expect(over.status).toBe("over_committed");
    expect(dec(over.unplannedHours).toNumber()).toBe(-5);
    expect(over.requiredWeeklyHours).toBeNull();
  });

  it("keeps a final-day weekly requirement visible", () => {
    const result = calculatePlanningCoverage({
      ...PERIOD,
      authorizedHours: "100",
      actualHours: "90",
      scheduledHours: "0",
      asOf: new Date("2025-12-31T00:00:00Z"),
    });
    expect(dec(result.requiredWeeklyHours!).toNumber()).toBe(70);
  });
});
