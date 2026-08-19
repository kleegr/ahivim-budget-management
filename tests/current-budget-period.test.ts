import { describe, it, expect } from "vitest";
import { currentBudgetPeriod } from "@/lib/business/calculation-strategy";

/**
 * The auto-rolling renewal: an active account's budget year always moves forward
 * so it is never "expired"; an inactive account stays frozen where it is.
 */
describe("currentBudgetPeriod (auto-rolling renewal)", () => {
  it("rolls an active account's past renewal forward to the current year", () => {
    const p = currentBudgetPeriod("2026-02-01", true, "2026-08-19");
    expect(p.effectiveRenewal).toBe("2027-02-01");
    expect(p.start).toBe("2026-02-01");
    expect(p.end).toBe("2027-02-01");
    expect(p.rolled).toBe(true);
  });

  it("rolls multiple whole years when the stored date is well in the past", () => {
    const p = currentBudgetPeriod("2023-05-01", true, "2026-08-19");
    expect(p.effectiveRenewal).toBe("2027-05-01");
    expect(p.start).toBe("2026-05-01");
    expect(p.rolled).toBe(true);
  });

  it("keeps a future renewal as-is for an active account", () => {
    const p = currentBudgetPeriod("2027-01-01", true, "2026-08-19");
    expect(p.effectiveRenewal).toBe("2027-01-01");
    expect(p.start).toBe("2026-01-01");
    expect(p.rolled).toBe(false);
  });

  it("does NOT roll an inactive account — it can legitimately read as expired", () => {
    const p = currentBudgetPeriod("2026-02-01", false, "2026-08-19");
    expect(p.effectiveRenewal).toBe("2026-02-01");
    expect(p.start).toBe("2025-02-01");
    expect(p.rolled).toBe(false);
  });

  it("treats the renewal day itself as the first day of the new budget year", () => {
    const p = currentBudgetPeriod("2026-08-19", true, "2026-08-19");
    expect(p.effectiveRenewal).toBe("2027-08-19");
    expect(p.start).toBe("2026-08-19");
  });

  it("returns nulls when there is no renewal date", () => {
    expect(currentBudgetPeriod(null, true, "2026-08-19")).toEqual({ start: null, end: null, effectiveRenewal: null, rolled: false });
  });
});
