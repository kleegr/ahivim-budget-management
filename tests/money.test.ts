import { describe, it, expect } from "vitest";
import {
  dec,
  tryDec,
  toMoney,
  toCents,
  sumMoney,
  divideEqually,
  closeEnough,
  variancePercent,
  formatMoney,
} from "@/lib/money";

describe("decimal-safe money", () => {
  it("does not inherit binary floating-point error", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754 doubles.
    expect(dec("0.1").plus(dec("0.2")).toString()).toBe("0.3");
    expect(sumMoney(["0.1", "0.2"])).toBe("0.3000");
  });

  it("routes float literals through their string form", () => {
    expect(dec(0.1).plus(dec(0.2)).toString()).toBe("0.3");
  });

  it("refuses non-finite numbers rather than coercing them to zero", () => {
    expect(() => dec(Number.NaN)).toThrow(TypeError);
    expect(() => dec(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it("strips currency formatting from spreadsheet cells", () => {
    expect(toMoney("$1,575,583.05")).toBe("1575583.0500");
  });

  it("parses numbers that use a space as the thousands separator (Google Sheet CSV export)", () => {
    // gviz CSV returns numbers as display text; some locales separate thousands
    // with a space or a non-breaking space rather than a comma.
    expect(toMoney("1 888.60")).toBe("1888.6000");
    expect(toMoney("10 563.10")).toBe("10563.1000");
    expect(toMoney("1 234.50")).toBe("1234.5000"); // non-breaking space
    expect(dec("1 888.60").toString()).toBe("1888.6");
  });

  it("treats blank and placeholder cells as zero, not as an error", () => {
    expect(toMoney("")).toBe("0.0000");
    expect(toMoney("-")).toBe("0.0000");
    expect(toMoney(null)).toBe("0.0000");
  });

  it("distinguishes an absent cell from a zero cell via tryDec", () => {
    expect(tryDec(null)).toBeNull();
    expect(tryDec("")).toBeNull();
    expect(tryDec("0")?.toString()).toBe("0");
  });

  it("rounds half-up to cents", () => {
    expect(toCents("1.005")).toBe("1.01");
    expect(toCents("2.675")).toBe("2.68");
  });

  it("keeps four-decimal storage scale distinct from two-decimal display", () => {
    expect(toMoney("1430370.965")).toBe("1430370.9650");
    expect(toCents("1430370.965")).toBe("1430370.97");
  });
});

describe("divideEqually", () => {
  it("splits evenly when the amount is divisible", () => {
    const { shares, remainder } = divideEqually("663", 3);
    expect(shares).toEqual(["221.0000", "221.0000", "221.0000"]);
    expect(remainder).toBe("0.0000");
  });

  it("never loses or invents money on an indivisible amount", () => {
    const { shares } = divideEqually("100", 3);
    const total = shares.reduce((a, s) => a.plus(dec(s)), dec(0));
    expect(total.toFixed(4)).toBe("100.0000");
  });

  it("puts the indivisible remainder on the final share only", () => {
    const { shares, remainder } = divideEqually("10", 3);
    expect(shares[0]).toBe("3.3333");
    expect(shares[1]).toBe("3.3333");
    expect(shares[2]).toBe("3.3334");
    expect(remainder).toBe("0.0001");
  });

  it("rejects a non-positive or fractional part count", () => {
    expect(() => divideEqually("100", 0)).toThrow(RangeError);
    expect(() => divideEqually("100", -1)).toThrow(RangeError);
    expect(() => divideEqually("100", 2.5)).toThrow(RangeError);
  });
});

describe("reconciliation helpers", () => {
  it("tolerates sub-cent drift but not real differences", () => {
    expect(closeEnough("663.00", "663.004")).toBe(true);
    expect(closeEnough("663.00", "664.00")).toBe(false);
  });

  it("reports variance as a signed fraction of the expected value", () => {
    // Self-Hire Respite billed at $23 against an expected $18.
    expect(variancePercent("23", "18").toFixed(6)).toBe("0.277778");
    expect(variancePercent("18", "18").toFixed(6)).toBe("0.000000");
  });

  it("does not divide by zero when the expected value is zero", () => {
    expect(variancePercent("23", "0").toString()).toBe("0");
  });

  it("formats money with grouping and a leading sign", () => {
    expect(formatMoney("1575583.05")).toBe("$1,575,583.05");
    expect(formatMoney("-221")).toBe("-$221.00");
  });
});
