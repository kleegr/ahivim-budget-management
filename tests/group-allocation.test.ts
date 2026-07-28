import { describe, it, expect } from "vitest";
import {
  buildGroupSignature,
  detectGroup,
  detectGroups,
  type GroupCandidateRow,
} from "@/lib/business/group-allocation";

/** The business owner's worked example: 13 hours, 3 individuals, $51 combined. */
function memberRow(individual: string, n: number, over: Partial<GroupCandidateRow> = {}): GroupCandidateRow {
  return {
    importRowId: `row-${n}`,
    sourceRowNumber: n,
    individualKey: individual,
    employeeKey: "emp-100",
    programKey: "day-hab",
    checkNumber: "5512",
    periodBegin: "2025-07-01",
    periodEnd: "2025-07-15",
    hours: "13",
    rate: "51",
    amount: "221",
    ...over,
  };
}

const GROUP = [memberRow("ind-a", 1), memberRow("ind-b", 2), memberRow("ind-c", 3)];

describe("the worked group example", () => {
  const result = detectGroup(GROUP, { expectedBaseRates: ["17", "19"] });

  it("detects a group of three", () => {
    expect(result.status).toBe("detected");
    expect(result.groupSize).toBe(3);
    expect(result.warningReason).toBeNull();
  });

  it("keeps the employee's physical hours at the full session length", () => {
    expect(result.physicalHours).toBe("13.0000");
  });

  it("gives every individual the FULL service hours, not a divided share", () => {
    expect(result.allocations).toHaveLength(3);
    for (const a of result.allocations) {
      expect(a.allocationHours).toBe("13.0000");
    }
    // The wrong answer would be 13 / 3.
    expect(result.allocations[0].allocationHours).not.toBe("4.3333");
  });

  it("divides the money equally: $17 rate portion and $221 each", () => {
    for (const a of result.allocations) {
      expect(a.allocatedRate).toBe("17.0000");
      expect(a.allocatedAmount).toBe("221.0000");
      expect(a.roundingAdjustment).toBe("0.0000");
    }
  });

  it("keeps the combined amount at $663", () => {
    expect(result.combinedAmount).toBe("663.0000");
    expect(result.combinedRate).toBe("51.0000");
    expect(result.baseIndividualRate).toBe("17.0000");
  });

  it("allocations sum back to the combined amount exactly", () => {
    const total = result.allocations.reduce((a, x) => a + Number(x.allocatedAmount), 0);
    expect(total).toBe(663);
  });

  it("gives no member more than another", () => {
    const amounts = new Set(result.allocations.map((a) => a.allocatedAmount));
    expect(amounts.size).toBe(1);
  });

  it("traces every allocation back to its source row", () => {
    expect(result.sourceRowRefs).toEqual([1, 2, 3]);
    expect(result.allocations.map((a) => a.importRowId)).toEqual(["row-1", "row-2", "row-3"]);
  });
});

describe("check number alone must not identify a group", () => {
  it("separates rows that share a check number but not an employee", () => {
    const rows = [
      memberRow("ind-a", 1),
      memberRow("ind-b", 2, { employeeKey: "emp-200" }),
    ];
    const sigs = new Set(rows.map(buildGroupSignature));
    expect(sigs.size).toBe(2);

    const results = detectGroups(rows, { expectedBaseRates: ["17", "19"] });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "single")).toBe(true);
  });

  it("separates rows that share a check number but not a program", () => {
    const rows = [memberRow("ind-a", 1), memberRow("ind-b", 2, { programKey: "respite" })];
    expect(new Set(rows.map(buildGroupSignature)).size).toBe(2);
  });

  it("separates rows that share a check number but not a service period", () => {
    const rows = [memberRow("ind-a", 1), memberRow("ind-b", 2, { periodEnd: "2025-07-31" })];
    expect(new Set(rows.map(buildGroupSignature)).size).toBe(2);
  });

  it("is stable for identical business values", () => {
    expect(buildGroupSignature(memberRow("ind-a", 1))).toBe(
      buildGroupSignature(memberRow("ind-a", 99)),
    );
  });
});

describe("groups that fail validation go to review, never to silent grouping", () => {
  it("flags a repeated individual instead of paying them twice", () => {
    const rows = [memberRow("ind-a", 1), memberRow("ind-a", 2), memberRow("ind-c", 3)];
    const r = detectGroup(rows, { expectedBaseRates: ["17", "19"] });
    expect(r.status).toBe("needs_review");
    expect(r.warningReason).toContain("individuals are not distinct");
  });

  it("produces no allocations for a row bucket awaiting review", () => {
    const rows = [memberRow("ind-a", 1), memberRow("ind-a", 2)];
    expect(detectGroup(rows, { expectedBaseRates: ["17"] }).allocations).toEqual([]);
  });

  it("flags a combined rate that does not reconcile to group size x base", () => {
    const rows = [
      memberRow("ind-a", 1, { rate: "44" }),
      memberRow("ind-b", 2, { rate: "44" }),
      memberRow("ind-c", 3, { rate: "44" }),
    ];
    const r = detectGroup(rows, { expectedBaseRates: ["17", "19"] });
    expect(r.status).toBe("needs_review");
    expect(r.warningReason).toContain("combined rate does not reconcile");
  });

  it("explains the reason a bucket needs review", () => {
    const rows = [memberRow("ind-a", 1), memberRow("ind-a", 2)];
    const r = detectGroup(rows, { expectedBaseRates: ["17", "19"] });
    expect(r.warningReason).toMatch(/^Needs review: /);
    expect(r.confidence).not.toBe("1.000000");
  });
});

describe("group rows priced off either the internal or the agency rate", () => {
  it("accepts 3 x $17 internal pricing", () => {
    const r = detectGroup(GROUP, { expectedBaseRates: ["17", "19"] });
    expect(r.validation.combinedRateReconciles).toBe(true);
  });

  it("accepts 3 x $19 agency pricing", () => {
    const rows = GROUP.map((x, i) => memberRow(x.individualKey, i + 1, { rate: "57" }));
    const r = detectGroup(rows, { expectedBaseRates: ["17", "19"] });
    expect(r.validation.combinedRateReconciles).toBe(true);
    expect(r.combinedAmount).toBe("741.0000"); // 13 * 57
  });
});

describe("a lone row is not a group", () => {
  it("reports a single row without inventing a group", () => {
    const r = detectGroup([memberRow("ind-a", 1)], { expectedBaseRates: ["17", "19"] });
    expect(r.status).toBe("single");
    expect(r.groupSize).toBe(1);
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0].allocationHours).toBe("13.0000");
  });

  it("rejects an empty bucket rather than returning a hollow result", () => {
    expect(() => detectGroup([])).toThrow(RangeError);
  });
});
