import { describe, expect, it } from "vitest";
import { computeStrategy } from "@/lib/business/calculation-strategy";

describe("explicit Financial Setup percentages", () => {
  it.each([
    ["1%", "0.01", "990.0000"],
    ["0.5%", "0.005", "995.0000"],
    ["100%", "1", "0.0000"],
    ["0%", "0", "1000.0000"],
  ])("uses %s as the entered percent", (cut, fraction, net) => {
    const result = computeStrategy({
      lines: [{ programLabel: "Example", hours: "120", internalRate: "100" }],
      cut1Percent: cut,
      afterAll: "0",
    });
    expect(result.cut1Fraction).toBe(fraction);
    expect(result.net).toBe(net);
    expect(result.afterAll).toBe("0.0000");
  });

  it("keeps fractional API inputs and sequential cuts compatible", () => {
    const result = computeStrategy({
      lines: [{ programLabel: "Example", hours: "120", internalRate: "100" }],
      cut1Percent: "0.24",
      cut2Percent: "30%",
    });
    expect(result.net).toBe("532.0000");
  });
});
