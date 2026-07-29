import { describe, it, expect } from "vitest";
import { computeCalculation, agencySplit } from "@/lib/business/calculation";
import { dec } from "@/lib/money";

const n = (s: string | null) => (s === null ? null : dec(s).toNumber());

describe("calculation engine — cuts and monthly", () => {
  it("computes annual gross, monthly gross and every step in order", () => {
    const r = computeCalculation({ annualAuthorizedHours: "1000", programRate: "17", months: 12 });
    expect(n(r.annualGross)).toBe(17000);
    expect(n(r.monthlyGross)).toBeCloseTo(1416.6667, 3);
    // steps are labelled and ordered
    expect(r.steps[0].key).toBe("annual_gross");
    expect(r.steps.map((s) => s.key)).toEqual(
      expect.arrayContaining(["annual_gross", "monthly_gross", "cut1", "cut2", "final_gross", "final_net", "after_all"]),
    );
  });

  it("applies a first cut and a SECOND SEQUENTIAL cut, preserving each amount", () => {
    const r = computeCalculation({
      annualAuthorizedHours: "1000", programRate: "17",
      cut1Percent: "10", cut2Percent: "5", cutOrder: "sequential",
    });
    // base 17000 - 10% = 15300; then 5% of 15300 = 765 -> 14535
    expect(n(r.cut1Amount)).toBe(1700);
    expect(n(r.afterCut1)).toBe(15300);
    expect(n(r.cut2Amount)).toBe(765);
    expect(n(r.afterCut2)).toBe(14535);
  });

  it("a parallel cut order takes both cuts off the original base", () => {
    const r = computeCalculation({
      annualAuthorizedHours: "1000", programRate: "17",
      cut1Percent: "10", cut2Percent: "5", cutOrder: "parallel",
    });
    // 17000 - 1700 - (5% of 17000 = 850) = 14450
    expect(n(r.cut2Amount)).toBe(850);
    expect(n(r.afterCut2)).toBe(14450);
  });

  it("adds the clock/manual adjustment then derives final gross, net and After All", () => {
    const r = computeCalculation({
      annualAuthorizedHours: "1000", programRate: "17",
      cut1Percent: "10", cut2Percent: "5", clockAdjustment: "100",
      netAdjustment: "-35", afterAllAdjustment: "-15",
    });
    expect(n(r.finalGross)).toBe(14635); // 14535 + 100
    expect(n(r.finalNet)).toBe(14600);   // 14635 - 35
    expect(n(r.afterAll)).toBe(14585);   // 14600 - 15
  });

  it("honours an individual rate override over the program rate", () => {
    const r = computeCalculation({ annualAuthorizedHours: "100", programRate: "17", individualRateOverride: "20" });
    expect(n(r.effectiveRate)).toBe(20);
    expect(n(r.annualGross)).toBe(2000);
  });

  it("uses authorized dollars directly when the authorization is dollar-based", () => {
    const r = computeCalculation({ annualAuthorizedDollars: "9000", programRate: "17" });
    expect(n(r.annualGross)).toBe(9000);
  });

  it("keeps agency, internal and agency-additional separate ($19 vs $17 -> $2/h)", () => {
    const r = computeCalculation({ annualAuthorizedHours: "1000", programRate: "17", agencyRate: "19" });
    expect(n(r.agencyGross)).toBe(19000);
    expect(n(r.internalAmount)).toBe(17000);
    expect(n(r.agencyAdditional)).toBe(2000); // (19-17) x 1000
  });
});

describe("agency split", () => {
  it("splits one hour at $19 agency / $17 internal into a $2 additional", () => {
    const s = agencySplit({ hours: "1", agencyRate: "19", internalRate: "17" });
    expect(n(s.agencyGross)).toBe(19);
    expect(n(s.internalAmount)).toBe(17);
    expect(n(s.agencyAdditional)).toBe(2);
  });

  it("self-hire does not convert: agency equals internal, no additional", () => {
    const s = agencySplit({ hours: "4", agencyRate: null, internalRate: "18", converts: false });
    expect(n(s.agencyGross)).toBe(72);
    expect(n(s.internalAmount)).toBe(72);
    expect(n(s.agencyAdditional)).toBe(0);
  });

  it("a program that does not convert keeps agency == internal even with an agency rate", () => {
    const s = agencySplit({ hours: "10", agencyRate: "25", internalRate: "21", converts: false });
    expect(n(s.agencyGross)).toBe(210);
    expect(n(s.agencyAdditional)).toBe(0);
  });
});
