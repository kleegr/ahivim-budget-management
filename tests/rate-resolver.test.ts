import { describe, it, expect } from "vitest";
import {
  resolveEffectiveRate,
  pickEffectiveRateRow,
  type RateScheduleRow,
} from "@/lib/business/rate-resolver";

/**
 * The ONE effective-dated rate resolver. These cases pin the window semantics
 * (effective_from <= asOf AND (effective_to IS NULL OR effective_to >= asOf),
 * latest effective_from wins) that all four call sites now share.
 */
describe("resolveEffectiveRate — effective-dated window, latest effective_from wins", () => {
  it("applies an open-ended row (null effective_to) indefinitely", () => {
    const rows: RateScheduleRow[] = [
      { effectiveFrom: "2000-01-01", effectiveTo: null, agencyRate: "25", internalRate: "21" },
    ];
    expect(resolveEffectiveRate(rows, "2000-01-01")).toEqual({ agencyRate: "25", internalRate: "21" });
    expect(resolveEffectiveRate(rows, "2025-06-15")).toEqual({ agencyRate: "25", internalRate: "21" });
    // Even far in the future, an open-ended row is still in force.
    expect(resolveEffectiveRate(rows, "9999-12-31")).toEqual({ agencyRate: "25", internalRate: "21" });
  });

  it("treats a missing (undefined) effective_to the same as open-ended", () => {
    const rows: RateScheduleRow[] = [{ effectiveFrom: "2020-01-01", internalRate: "38" }];
    expect(resolveEffectiveRate(rows, "2024-03-01")).toEqual({ agencyRate: null, internalRate: "38" });
  });

  it("honours a closed window: in force inside it, absent before and after", () => {
    const rows: RateScheduleRow[] = [
      { effectiveFrom: "2022-01-01", effectiveTo: "2022-12-31", agencyRate: "19", internalRate: "17" },
    ];
    // Boundaries are inclusive on both ends.
    expect(resolveEffectiveRate(rows, "2022-01-01")).toEqual({ agencyRate: "19", internalRate: "17" });
    expect(resolveEffectiveRate(rows, "2022-06-30")).toEqual({ agencyRate: "19", internalRate: "17" });
    expect(resolveEffectiveRate(rows, "2022-12-31")).toEqual({ agencyRate: "19", internalRate: "17" });
    // Outside the window there is nothing in force.
    expect(resolveEffectiveRate(rows, "2021-12-31")).toBeNull();
    expect(resolveEffectiveRate(rows, "2023-01-01")).toBeNull();
  });

  it("picks the LATEST effective_from when several rows overlap on a date", () => {
    // A correction is a newer row layered over an older open-ended one.
    const rows: RateScheduleRow[] = [
      { effectiveFrom: "2000-01-01", effectiveTo: null, internalRate: "17" },
      { effectiveFrom: "2024-01-01", effectiveTo: null, internalRate: "20" },
      { effectiveFrom: "2022-01-01", effectiveTo: null, internalRate: "18" },
    ];
    // Before the corrections, the original row applies.
    expect(resolveEffectiveRate(rows, "2001-01-01")?.internalRate).toBe("17");
    // Between corrections, the 2022 row is the latest in force.
    expect(resolveEffectiveRate(rows, "2023-06-01")?.internalRate).toBe("18");
    // After the last correction, it wins even though the older rows still overlap.
    expect(resolveEffectiveRate(rows, "2025-01-01")?.internalRate).toBe("20");
  });

  it("ignores a future-dated row that is not yet in effect", () => {
    const rows: RateScheduleRow[] = [
      { effectiveFrom: "2020-01-01", effectiveTo: null, internalRate: "21" },
      { effectiveFrom: "2030-01-01", effectiveTo: null, internalRate: "30" }, // a scheduled future raise
    ];
    // As of today the future row does not apply — the current rate holds.
    expect(resolveEffectiveRate(rows, "2025-06-01")?.internalRate).toBe("21");
    // Once its effective_from arrives, it takes over.
    expect(resolveEffectiveRate(rows, "2030-01-01")?.internalRate).toBe("30");
  });

  it("returns null when no row is in force and when there are no rows at all", () => {
    expect(resolveEffectiveRate([], "2025-01-01")).toBeNull();
    const onlyFuture: RateScheduleRow[] = [{ effectiveFrom: "2030-01-01", internalRate: "30" }];
    expect(resolveEffectiveRate(onlyFuture, "2025-01-01")).toBeNull();
  });

  it("pickEffectiveRateRow preserves extra columns on the chosen row", () => {
    const rows = [
      { programId: "p1", effectiveFrom: "2000-01-01", effectiveTo: null, internalRate: "17" },
      { programId: "p1", effectiveFrom: "2024-01-01", effectiveTo: null, internalRate: "20" },
    ];
    const chosen = pickEffectiveRateRow(rows, "2025-01-01");
    expect(chosen?.programId).toBe("p1");
    expect(chosen?.effectiveFrom).toBe("2024-01-01");
  });
});
