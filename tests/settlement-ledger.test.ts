import { describe, expect, it } from "vitest";
import {
  individualSettlementTargets,
  paceComparison,
  settlementBalance,
  settlementState,
  settlementTargetDelta,
} from "@/lib/business/settlement-ledger";

describe("individual settlement targets", () => {
  it("annualizes sequential monthly cuts and counts fixed Masser once", () => {
    const targets = individualSettlementTargets({
      lines: [{ programLabel: "Com Hab", hours: "120", internalRate: "21" }],
      monthDivisor: "12",
      cut1Percent: "0.10",
      cut2Percent: "0.20",
      clockAdjustment: "-25",
      otherAdjustment: "10",
      afterAll: "750",
    });

    expect(targets).toEqual([
      expect.objectContaining({ kind: "individual_cut_1", direction: "reserve", amount: "252.0000" }),
      expect.objectContaining({ kind: "individual_cut_2", direction: "reserve", amount: "453.6000" }),
      expect.objectContaining({ kind: "individual_clock", direction: "receivable", amount: "300.0000" }),
      expect.objectContaining({ kind: "individual_other", direction: "reserve", amount: "120.0000" }),
      expect.objectContaining({ kind: "individual_masser", direction: "reserve", amount: "750.0000", monthlyAmount: null }),
    ]);
  });

  it("does not create zero-value work", () => {
    expect(individualSettlementTargets({ lines: [] })).toEqual([]);
  });

  it("can include zero targets so recalculation can close prior work", () => {
    const targets = individualSettlementTargets({ lines: [] }, { includeZero: true });

    expect(targets.map((target) => [target.kind, target.amount])).toEqual([
      ["individual_cut_1", "0.0000"],
      ["individual_cut_2", "0.0000"],
      ["individual_clock", "0.0000"],
      ["individual_other", "0.0000"],
      ["individual_masser", "0.0000"],
    ]);
  });
});

describe("settlement balances", () => {
  it("tracks partial, settled, and overpaid credit states", () => {
    expect(settlementState("120", "0")).toBe("open");
    expect(settlementState("120", "50")).toBe("partial");
    expect(settlementState("120", "120")).toBe("settled");
    expect(settlementState("120", "145")).toBe("credit");
    expect(settlementState("120", "50", true)).toBe("void");
    expect(settlementBalance("120", "145")).toBe("-25.0000");
    expect(settlementBalance("120", "50", true)).toBe("0.0000");
  });

  it("creates signed append-only deltas when recalculated targets change direction", () => {
    expect(settlementTargetDelta({
      previousAmount: "100",
      previousDirection: "payable",
      nextAmount: "80",
      nextDirection: "payable",
      positiveDirection: "payable",
    })).toEqual({ direction: "receivable", amount: "20.0000", signedAmount: "-20.0000" });

    expect(settlementTargetDelta({
      previousAmount: "100",
      previousDirection: "payable",
      nextAmount: "20",
      nextDirection: "receivable",
      positiveDirection: "payable",
    })).toEqual({ direction: "receivable", amount: "120.0000", signedAmount: "-120.0000" });

    expect(settlementTargetDelta({
      previousAmount: "100",
      previousDirection: "receivable",
      nextAmount: "80",
      nextDirection: "receivable",
      positiveDirection: "reserve",
    })).toEqual({ direction: "reserve", amount: "20.0000", signedAmount: "20.0000" });

    expect(settlementTargetDelta({
      previousAmount: "80",
      previousDirection: "payable",
      nextAmount: "80",
      nextDirection: "payable",
      positiveDirection: "payable",
    })).toBeNull();
  });

  it("compares transaction progress with time elapsed", () => {
    expect(paceComparison("900", "1000", "0.75")).toEqual({
      actualPercent: "0.9",
      elapsedPercent: "0.75",
      variancePercent: "0.15",
    });
  });
});
