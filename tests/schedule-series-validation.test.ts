import { describe, expect, it } from "vitest";
import { validateSeriesInput, type CreateSeriesInput } from "@/lib/manage/schedule";

const base: CreateSeriesInput = {
  employeeId: "00000000-0000-4000-8000-000000000001",
  programId: "00000000-0000-4000-8000-000000000002",
  individualIds: ["00000000-0000-4000-8000-000000000003"],
  frequency: "weekly",
  interval: 1,
  weekdays: [1],
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  startTime: "09:00",
  endTime: "11:00",
  durationHours: "2",
};

describe("recurring schedule validation", () => {
  it("requires an explicit weekday for a weekly schedule", () => {
    expect(validateSeriesInput({ ...base, weekdays: [] })).toBe("Choose at least one weekday.");
    expect(validateSeriesInput({ ...base, weekdays: undefined })).toBe("Choose at least one weekday.");
  });

  it("does not require weekdays for a daily schedule", () => {
    expect(validateSeriesInput({ ...base, frequency: "daily", weekdays: [] })).toBeNull();
  });

  it("rejects ranges that would silently truncate after 400 visits", () => {
    expect(validateSeriesInput({
      ...base,
      frequency: "daily",
      weekdays: [],
      startDate: "2026-01-01",
      endDate: "2027-02-04",
    })).toBeNull();
    expect(validateSeriesInput({
      ...base,
      frequency: "daily",
      weekdays: [],
      startDate: "2026-01-01",
      endDate: "2027-02-05",
    })).toBe("A recurring schedule can include up to 400 visits. Shorten the date range or use a longer interval.");
  });
});
