import { describe, it, expect } from "vitest";
import { derivePeriodDates } from "@/lib/manage/budget-periods";

describe("derivePeriodDates (pure)", () => {
  it("calendar: uses the explicit year for Jan 1 – Dec 31", () => {
    expect(derivePeriodDates("calendar", null, 2026)).toEqual({
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
  });

  it("calendar: takes the year from the start date when no year is given", () => {
    expect(derivePeriodDates("calendar", "2025-07-14")).toEqual({
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
  });

  it("calendar: an explicit year wins over the start date's year", () => {
    expect(derivePeriodDates("calendar", "2025-07-14", 2027)).toEqual({
      startDate: "2027-01-01",
      endDate: "2027-12-31",
    });
  });

  it("calendar: throws when neither a year nor a usable start date is given", () => {
    expect(() => derivePeriodDates("calendar", null)).toThrow();
  });

  it("rolling: twelve months from the start, minus a day", () => {
    expect(derivePeriodDates("rolling", "2025-03-15")).toEqual({
      startDate: "2025-03-15",
      endDate: "2026-03-14",
    });
  });

  it("rolling: a Jan 1 start lands exactly on Dec 31", () => {
    expect(derivePeriodDates("rolling", "2025-01-01")).toEqual({
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
  });

  it("rolling: a Feb 29 start clamps to the following Feb 28", () => {
    expect(derivePeriodDates("rolling", "2024-02-29")).toEqual({
      startDate: "2024-02-29",
      endDate: "2025-02-28",
    });
  });

  it("rolling: throws without a start date", () => {
    expect(() => derivePeriodDates("rolling", null)).toThrow();
  });

  it("custom: echoes the start date (the caller supplies the explicit end)", () => {
    expect(derivePeriodDates("custom", "2025-04-01")).toEqual({
      startDate: "2025-04-01",
      endDate: "2025-04-01",
    });
  });
});
