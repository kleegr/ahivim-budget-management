import { describe, it, expect } from "vitest";
import {
  calculateForecast, MIN_ELAPSED_DAYS, MIN_OBSERVATIONS, addDays,
} from "@/lib/business/forecast";
import {
  calculatePeriodElapsed, calculateProgramUtilization, classifyUtilization,
  calculatePlanningMonths, STATUS_LABELS,
} from "@/lib/business/utilization";
import { dec } from "@/lib/money";

const PERIOD = { startDate: "2025-01-01", endDate: "2025-12-31" };
const midYear = new Date("2025-07-02T00:00:00Z");

describe("period elapsed", () => {
  it("measures the period and how much of it has passed", () => {
    const elapsed = calculatePeriodElapsed(PERIOD, midYear);
    expect(elapsed.totalDays).toBe(365);
    expect(elapsed.hasStarted).toBe(true);
    expect(elapsed.hasEnded).toBe(false);
    expect(elapsed.elapsedDays + elapsed.remainingDays).toBe(elapsed.totalDays);
    expect(dec(elapsed.timeElapsedPercent).toNumber()).toBeGreaterThan(0.49);
    expect(dec(elapsed.timeElapsedPercent).toNumber()).toBeLessThan(0.51);
  });

  it("knows a period that has not started", () => {
    const elapsed = calculatePeriodElapsed(PERIOD, new Date("2024-06-01T00:00:00Z"));
    expect(elapsed.hasStarted).toBe(false);
    expect(dec(elapsed.timeElapsedPercent).toNumber()).toBe(0);
  });

  it("knows a period that has ended", () => {
    const elapsed = calculatePeriodElapsed(PERIOD, new Date("2026-06-01T00:00:00Z"));
    expect(elapsed.hasEnded).toBe(true);
    expect(elapsed.remainingDays).toBe(0);
  });

  it("reports planning months for the period", () => {
    expect(Number(calculatePlanningMonths(PERIOD))).toBeGreaterThan(11.9);
    expect(Number(calculatePlanningMonths(PERIOD))).toBeLessThan(12.1);
  });
});

describe("program utilization", () => {
  const elapsed = calculatePeriodElapsed(PERIOD, midYear);

  it("computes remaining hours and value from authorized and used", () => {
    const u = calculateProgramUtilization(
      { authorizedHours: "100", usedHours: "40", internalRate: "17" },
      elapsed,
    );
    expect(dec(u.remainingHours).toNumber()).toBe(60);
    expect(dec(u.authorizedValue).toNumber()).toBe(1700);
    expect(dec(u.usedValue).toNumber()).toBe(680);
    expect(dec(u.remainingValue).toNumber()).toBe(1020);
    expect(dec(u.usagePercent).toNumber()).toBeCloseTo(0.4, 6);
  });

  it("flags consumption beyond the authorization", () => {
    const u = calculateProgramUtilization(
      { authorizedHours: "100", usedHours: "120", internalRate: "17" },
      elapsed,
    );
    expect(u.status).toBe("over_authorization");
    expect(dec(u.remainingHours).toNumber()).toBe(-20);
  });

  it("classifies pace against the calendar, not against a fixed number", () => {
    // "not_started" is a statement about the PERIOD, not about usage: zero
    // hours halfway through a period is behind pace, not "not started".
    const notStarted = calculatePeriodElapsed(PERIOD, new Date("2024-06-01T00:00:00Z"));
    expect(classifyUtilization("0", notStarted)).toBe("not_started");
    expect(classifyUtilization("0", elapsed)).toBe("behind_pace");
    expect(classifyUtilization("0.20", elapsed)).toBe("behind_pace");
    expect(classifyUtilization("0.50", elapsed)).toBe("on_pace");
    expect(classifyUtilization("0.80", elapsed)).toBe("ahead_of_pace");
    expect(classifyUtilization("1.00", elapsed)).toBe("fully_used");
    expect(classifyUtilization("1.20", elapsed)).toBe("over_authorization");
  });

  it("has a readable label for every status", () => {
    for (const status of Object.keys(STATUS_LABELS)) {
      expect(STATUS_LABELS[status as keyof typeof STATUS_LABELS].length).toBeGreaterThan(0);
    }
  });
});

describe("forecast suppression", () => {
  const elapsed = calculatePeriodElapsed(PERIOD, midYear);

  it("projects when there is enough history", () => {
    const result = calculateForecast({
      authorizedHours: "520", usedHours: "260", elapsed,
      periodStartDate: PERIOD.startDate, observationCount: 26,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(Number(result.averageWeeklyUsage)).toBeGreaterThan(0);
    expect(result.observationCount).toBe(26);
  });

  it("refuses to project from too little elapsed time", () => {
    const early = calculatePeriodElapsed(PERIOD, new Date("2025-01-10T00:00:00Z"));
    const result = calculateForecast({
      authorizedHours: "520", usedHours: "10", elapsed: early,
      periodStartDate: PERIOD.startDate, observationCount: 10,
    });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe("insufficient_elapsed_time");
    expect(result.message).toContain(String(MIN_ELAPSED_DAYS));
    expect(result).not.toHaveProperty("estimatedExhaustionDate");
  });

  it("refuses to project from too few observations", () => {
    const result = calculateForecast({
      authorizedHours: "520", usedHours: "10", elapsed,
      periodStartDate: PERIOD.startDate, observationCount: MIN_OBSERVATIONS - 1,
    });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toBe("insufficient_observations");
  });

  it("refuses to project before the period starts", () => {
    const notStarted = calculatePeriodElapsed(PERIOD, new Date("2024-06-01T00:00:00Z"));
    const result = calculateForecast({
      authorizedHours: "520", usedHours: "0", elapsed: notStarted,
      periodStartDate: PERIOD.startDate, observationCount: 50,
    });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe("period_not_started");
  });

  it("refuses to project with no authorization and with no usage", () => {
    const noAuth = calculateForecast({
      authorizedHours: "0", usedHours: "0", elapsed,
      periodStartDate: PERIOD.startDate, observationCount: 50,
    });
    expect(noAuth.available).toBe(false);
    if (!noAuth.available) expect(noAuth.reason).toBe("no_authorization");

    const noUse = calculateForecast({
      authorizedHours: "520", usedHours: "0", elapsed,
      periodStartDate: PERIOD.startDate, observationCount: 50,
    });
    expect(noUse.available).toBe(false);
    if (!noUse.available) expect(noUse.reason).toBe("no_usage_recorded");
  });

  it("always explains itself when it declines", () => {
    const result = calculateForecast({
      authorizedHours: "520", usedHours: "0", elapsed,
      periodStartDate: PERIOD.startDate, observationCount: 1,
    });
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.message.length).toBeGreaterThan(20);
      expect(result.message).not.toMatch(/undefined|NaN/);
    }
  });

  it("adds days without floating-point drift", () => {
    expect(addDays("2025-01-01", 31)).toBe("2025-02-01");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });
});
