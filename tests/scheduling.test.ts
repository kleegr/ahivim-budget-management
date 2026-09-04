import { describe, it, expect } from "vitest";
import {
  expectedBilling, timesOverlap, durationBetween, minutesOf, generateOccurrences,
  isScheduleDate, MAX_SERIES_OCCURRENCES,
} from "@/lib/business/scheduling";
import { dec } from "@/lib/money";

describe("expected billing", () => {
  it("values a single agency session at hours x rate", () => {
    const b = expectedBilling({ hours: "10", agencyRate: "19", internalRate: "17" });
    expect(dec(b.agencyGross).toNumber()).toBe(190);
    expect(dec(b.internalAmount).toNumber()).toBe(170);
    expect(dec(b.expectedRate).toNumber()).toBe(19);
    expect(dec(b.perIndividual.hours).toNumber()).toBe(10);
  });

  it("self-hire does not convert (agency == internal)", () => {
    const b = expectedBilling({ hours: "4", agencyRate: null, internalRate: "18" });
    expect(dec(b.agencyGross).toNumber()).toBe(72);
    expect(dec(b.internalAmount).toNumber()).toBe(72);
    expect(dec(b.expectedRate).toNumber()).toBe(18);
  });

  it("a group divides money but never hours", () => {
    const b = expectedBilling({ hours: "13", groupSize: 3, agencyRate: "19", internalRate: "17" });
    // each individual: full 13 hours, $221 internal; combined = 3x.
    expect(dec(b.perIndividual.hours).toNumber()).toBe(13);
    expect(dec(b.perIndividual.amount).toNumber()).toBe(221);
    expect(dec(b.internalAmount).toNumber()).toBe(663);
    expect(dec(b.agencyGross).toNumber()).toBe(741);
  });
});

describe("time helpers", () => {
  it("parses HH:MM and computes duration", () => {
    expect(minutesOf("09:30")).toBe(570);
    expect(minutesOf("25:00")).toBeNull();
    expect(dec(durationBetween("09:00", "12:30")!).toNumber()).toBe(3.5);
    expect(durationBetween("12:00", "09:00")).toBeNull();
  });

  it("detects overlaps, treating missing times as all-day", () => {
    expect(timesOverlap("09:00", "10:00", "09:30", "11:00")).toBe(true);
    expect(timesOverlap("09:00", "10:00", "10:00", "11:00")).toBe(false);
    expect(timesOverlap("09:00", "10:00", null, null)).toBe(true);
  });
});

describe("recurrence", () => {
  it("expands a weekly Mon/Wed schedule", () => {
    const days = generateOccurrences({
      frequency: "weekly", weekdays: [1, 3], startDate: "2025-01-06", endDate: "2025-01-19",
    });
    // Jan 2025: Mon 6, Wed 8, Mon 13, Wed 15 (within 6..19); 20th is a Mon but > 19.
    expect(days).toEqual(["2025-01-06", "2025-01-08", "2025-01-13", "2025-01-15"]);
  });

  it("honours a 2-week interval", () => {
    const days = generateOccurrences({
      frequency: "weekly", interval: 2, weekdays: [1], startDate: "2025-01-06", endDate: "2025-02-03",
    });
    expect(days).toEqual(["2025-01-06", "2025-01-20", "2025-02-03"]);
  });

  it("expands a daily schedule and caps runaway ranges", () => {
    const days = generateOccurrences({ frequency: "daily", startDate: "2025-01-01", endDate: "2025-01-05" });
    expect(days).toHaveLength(5);
    const capped = generateOccurrences({ frequency: "daily", startDate: "2020-01-01", endDate: "2030-01-01" });
    expect(capped).toHaveLength(MAX_SERIES_OCCURRENCES);
    const overflowProbe = generateOccurrences({
      frequency: "daily", startDate: "2020-01-01", endDate: "2030-01-01", max: MAX_SERIES_OCCURRENCES + 1,
    });
    expect(overflowProbe).toHaveLength(MAX_SERIES_OCCURRENCES + 1);
  });

  it("starts a future expansion without resetting the recurrence phase", () => {
    expect(generateOccurrences({
      frequency: "daily", interval: 2, startDate: "2025-01-01", endDate: "2025-01-10",
      fromDate: "2025-01-04",
    })).toEqual(["2025-01-05", "2025-01-07", "2025-01-09"]);
    expect(generateOccurrences({
      frequency: "weekly", interval: 2, weekdays: [1], startDate: "2025-01-06", endDate: "2025-02-03",
      fromDate: "2025-01-13",
    })).toEqual(["2025-01-20", "2025-02-03"]);
  });

  it("returns nothing for an inverted range", () => {
    expect(generateOccurrences({ frequency: "weekly", weekdays: [1], startDate: "2025-02-01", endDate: "2025-01-01" })).toEqual([]);
  });

  it("rejects regex-shaped dates that are not real calendar dates", () => {
    expect(isScheduleDate("2026-02-28")).toBe(true);
    expect(isScheduleDate("2026-02-29")).toBe(false);
    expect(generateOccurrences({
      frequency: "daily",
      startDate: "2026-02-29",
      endDate: "2026-03-02",
    })).toEqual([]);
  });
});
