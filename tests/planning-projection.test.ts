import { describe, expect, it } from "vitest";
import { projectSeries } from "@/lib/business/planning-projection";

describe("planning series projection", () => {
  it("uses generated weekly occurrences to total per-individual hours", () => {
    const projection = projectSeries({
      frequency: "weekly",
      interval: 1,
      weekdays: [1],
      startDate: "2025-01-06",
      endDate: "2025-12-29",
    }, "2.5");

    expect(projection.occurrenceCount).toBe(52);
    expect(projection.totalHours).toBe("130.0000");
    expect(projection.dates[0]).toBe("2025-01-06");
    expect(projection.dates.at(-1)).toBe("2025-12-29");
  });

  it("treats an empty weekly weekday selection as invalid", () => {
    expect(projectSeries({
      frequency: "weekly",
      weekdays: [],
      startDate: "2025-01-06",
      endDate: "2025-12-29",
    }, "2")).toEqual({ dates: [], occurrenceCount: 0, totalHours: null });
  });
});
