import { describe, expect, it } from "vitest";
import { reservePresentation } from "@/lib/business/reserve-presentation";

const verified = { setupHistoryAvailable: true, ledgerDirty: false, activePlans: 1,
  actionablePlans: 1, reviewRequiredPlans: 0, missingRenewalPlans: 0 };

describe("reserve balance presentation", () => {
  it("does not call a fully held balance zero or export a numeric zero", () => {
    const balance = reservePresentation({ ...verified, actionablePlans: 0, reviewRequiredPlans: 1 });
    expect(balance.display("0.0000")).toBe("Unavailable");
    expect(balance.amount("0.0000")).toBeNull();
    expect(balance.status).toContain("held balances excluded");
  });
  it("labels positive and zero mixed positions as verified subtotals", () => {
    const balance = reservePresentation({ ...verified, activePlans: 2, reviewRequiredPlans: 1 });
    expect(balance.display("70.0000")).toBe("$70.00 verified subtotal");
    expect(balance.display("0.0000")).toBe("$0.00 verified subtotal");
    expect(balance.amount("70.0000")).toBe("70.0000");
  });
  it.each([
    { ledgerDirty: true }, { setupHistoryAvailable: false },
    { actionablePlans: 0, missingRenewalPlans: 1 }, { actionablePlans: 0 },
  ])("withholds stale, unknown or untracked balances: %j", (change) => {
    const balance = reservePresentation({ ...verified, ...change });
    expect(balance.display("25.0000")).toBe("Unavailable");
    expect(balance.amount("25.0000")).toBeNull();
  });
  it("preserves genuine zero balances and credits", () => {
    const balance = reservePresentation(verified);
    expect(balance.display("0.0000")).toBe("$0.00");
    expect(balance.display("25.0000")).toBe("$25.00");
    expect(balance.incomplete).toBe(false);
    expect(reservePresentation({ ...verified, actionablePlans: 0, approvedMonthlyPlan: "0.0000" }).display("0.0000")).toBe("$0.00");
  });
});
