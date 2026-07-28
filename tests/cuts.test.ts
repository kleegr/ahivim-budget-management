import { describe, it, expect } from "vitest";
import {
  calculateSequentialCuts,
  calculateThirdCutAndEmployeeCash,
  calculateAccountWaterfall,
} from "@/lib/business/cuts";

describe("cuts are sequential, not parallel", () => {
  const result = calculateSequentialCuts({
    gross: "1000",
    firstCutPercent: "0.10",
    secondCutPercent: "0.05",
  });

  it("takes the first cut from the gross", () => {
    expect(result.firstCutAmount).toBe("100.0000");
    expect(result.remainingAfterFirstCut).toBe("900.0000");
  });

  it("takes the second cut from the balance after the first cut", () => {
    // 5% of 900 == 45. The parallel mistake would give 5% of 1000 == 50.
    expect(result.secondCutAmount).toBe("45.0000");
    expect(result.secondCutAmount).not.toBe("50.0000");
    expect(result.remainingAfterSecondCut).toBe("855.0000");
  });

  it("conserves the gross across the whole waterfall", () => {
    const total =
      Number(result.firstCutAmount) +
      Number(result.secondCutAmount) +
      Number(result.remainingAfterSecondCut);
    expect(total).toBe(1000);
  });

  it("is order-sensitive: swapping the percentages changes the result", () => {
    const swapped = calculateSequentialCuts({
      gross: "1000",
      firstCutPercent: "0.05",
      secondCutPercent: "0.10",
    });
    expect(swapped.remainingAfterSecondCut).toBe("855.0000");
    expect(swapped.firstCutAmount).toBe("50.0000");
    expect(swapped.secondCutAmount).toBe("95.0000");
  });

  it("handles a zero cut without distorting the balance", () => {
    const none = calculateSequentialCuts({
      gross: "1000",
      firstCutPercent: "0",
      secondCutPercent: "0",
    });
    expect(none.remainingAfterSecondCut).toBe("1000.0000");
  });

  it("rejects a percentage expressed as a whole number", () => {
    // 10 would silently mean 1000%.
    expect(() =>
      calculateSequentialCuts({ gross: "1000", firstCutPercent: "10", secondCutPercent: "0.05" }),
    ).toThrow(RangeError);
  });

  it("rejects a negative percentage", () => {
    expect(() =>
      calculateSequentialCuts({ gross: "1000", firstCutPercent: "-0.1", secondCutPercent: "0.05" }),
    ).toThrow(RangeError);
  });

  it("stays decimal-exact on a rate that has no binary representation", () => {
    const r = calculateSequentialCuts({
      gross: "0.70",
      firstCutPercent: "0.10",
      secondCutPercent: "0.10",
    });
    expect(r.firstCutAmount).toBe("0.0700");
    expect(r.remainingAfterFirstCut).toBe("0.6300");
    expect(r.remainingAfterSecondCut).toBe("0.5670");
  });
});

describe("the third cut is adjustable and independent", () => {
  it("subtracts the third cut to give employee cash", () => {
    const r = calculateThirdCutAndEmployeeCash({
      remainingAfterSecondCut: "855",
      thirdCutAmount: "55",
    });
    expect(r.employeeCashAmount).toBe("800.0000");
    expect(r.isOverdrawn).toBe(false);
  });

  it("is not forced to equal the remaining balance", () => {
    const r = calculateThirdCutAndEmployeeCash({
      remainingAfterSecondCut: "855",
      thirdCutAmount: "0",
    });
    expect(r.employeeCashAmount).toBe("855.0000");
  });

  it("reports an overdrawn account rather than clamping it to zero", () => {
    const r = calculateThirdCutAndEmployeeCash({
      remainingAfterSecondCut: "855",
      thirdCutAmount: "900",
    });
    expect(r.employeeCashAmount).toBe("-45.0000");
    expect(r.isOverdrawn).toBe(true);
  });
});

describe("the full account waterfall", () => {
  it("chains all three cuts into employee cash", () => {
    const r = calculateAccountWaterfall({
      gross: "1000",
      firstCutPercent: "0.10",
      secondCutPercent: "0.05",
      thirdCutAmount: "55",
    });
    expect(r.firstCutAmount).toBe("100.0000");
    expect(r.secondCutAmount).toBe("45.0000");
    expect(r.remainingAfterSecondCut).toBe("855.0000");
    expect(r.employeeCashAmount).toBe("800.0000");
  });

  it("conserves the gross across cuts plus cash", () => {
    const r = calculateAccountWaterfall({
      gross: "1234.56",
      firstCutPercent: "0.125",
      secondCutPercent: "0.075",
      thirdCutAmount: "100",
    });
    const total =
      Number(r.firstCutAmount) +
      Number(r.secondCutAmount) +
      Number(r.thirdCutAmount) +
      Number(r.employeeCashAmount);
    expect(total).toBeCloseTo(1234.56, 4);
  });
});
