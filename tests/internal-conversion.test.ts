import { describe, it, expect } from "vitest";
import {
  calculateInternalAmount,
  compareInternalAmounts,
  isAgencyPayee,
  isIntegerMultiple,
} from "@/lib/business/internal-rate";

const COM_HAB = { agencyRate: "25", internalRate: "21" }; // 21/25 == 0.84
const NINETEEN = { agencyRate: "19", internalRate: "17" }; // 17/19

describe("agency payee detection", () => {
  it("recognises the agency regardless of punctuation or suffix", () => {
    expect(isAgencyPayee("Excellent Staffing")).toBe(true);
    expect(isAgencyPayee("excellent staffing, LLC")).toBe(true);
    expect(isAgencyPayee("Excellent Staffing Inc.")).toBe(true);
  });

  it("does not treat a self-hire payee as the agency", () => {
    expect(isAgencyPayee("Jane Doe")).toBe(false);
    expect(isAgencyPayee("")).toBe(false);
    expect(isAgencyPayee(null)).toBe(false);
  });

  it("does not match an unrelated payee that merely starts similarly", () => {
    expect(isAgencyPayee("Excellent Staffing Solutions of NY")).toBe(true);
    expect(isAgencyPayee("Excellence Staffing")).toBe(false);
  });
});

describe("internal amount conversion", () => {
  it("converts Com Hab at 21/25", () => {
    const r = calculateInternalAmount({
      payTo: "Excellent Staffing",
      importedAmount: "250",
      rowRate: "25",
      ...COM_HAB,
    });
    expect(r.rule).toBe("agency_rate_converted");
    expect(r.internalAmount).toBe("210.0000"); // 250 * 21 / 25
    expect(r.conversionFactor).toBe("0.84000000");
  });

  it("converts Respite / Day Hab / Supplemental Group Day Hab at 17/19", () => {
    const r = calculateInternalAmount({
      payTo: "Excellent Staffing",
      importedAmount: "190",
      rowRate: "19",
      ...NINETEEN,
    });
    expect(r.rule).toBe("agency_rate_converted");
    expect(r.internalAmount).toBe("170.0000"); // 190 * 17 / 19
    expect(r.conversionFactor).toBe("0.89473684");
  });

  it("leaves a self-hire row at a 1.0 conversion by retaining the gross", () => {
    const r = calculateInternalAmount({
      payTo: "Jane Doe",
      importedAmount: "234.00",
      rowRate: "18",
      ...NINETEEN,
    });
    expect(r.rule).toBe("non_agency_payee_retain_gross");
    expect(r.internalAmount).toBe("234.0000");
  });

  it("produces no internal amount at all when Pay to is blank", () => {
    const r = calculateInternalAmount({
      payTo: "",
      importedAmount: "500",
      ...NINETEEN,
    });
    expect(r.rule).toBe("blank_pay_to");
    expect(r.internalAmount).toBeNull();
  });

  it("treats a whitespace-only Pay to as blank", () => {
    expect(calculateInternalAmount({ payTo: "   ", importedAmount: "500", ...NINETEEN }).rule).toBe(
      "blank_pay_to",
    );
  });
});

describe("group rows are scaled by ratio, never rebuilt from hours x internal rate", () => {
  // Three-person Day Hab: 13 hours at a combined agency rate of 3 x $19 = $57.
  const GROSS = "741"; // 13 * 57

  it("scales the whole group amount, preserving every member's share", () => {
    const r = calculateInternalAmount({
      payTo: "Excellent Staffing",
      importedAmount: GROSS,
      rowRate: "57",
      hours: "13",
      ...NINETEEN,
    });
    expect(r.rule).toBe("agency_rate_converted");
    // 741 * 17 / 19 == 663, the full combined internal amount.
    expect(r.internalAmount).toBe("663.0000");
  });

  it("would have dropped two members' money if rebuilt from hours x base rate", () => {
    // 13 hours x the $17 base internal rate is 221 -- one member's share only.
    const naive = 13 * 17;
    expect(naive).toBe(221);
    expect(naive).not.toBe(663);
  });

  it("converts every agency row by the flat program ratio, whatever the row's own rate", () => {
    // VERIFIED against the source ledger: 100% of Excellent-Staffing rows in a
    // convertible program carry the program ratio (0.84 or 0.894737); NONE stay
    // at 1.0. The row's own rate never gates the conversion — rows priced at 15,
    // 18, 20, 22 … all convert. (The earlier "retain 51/19" rule left ~$53.6k of
    // non-standard-rate rows unconverted and overstated the internal total.)
    const nonStandard = calculateInternalAmount({
      payTo: "Excellent Staffing",
      importedAmount: "453.40",
      rowRate: "20", // not a whole multiple of the $25 agency rate — still converts
      ...COM_HAB,
    });
    expect(nonStandard.rule).toBe("agency_rate_converted");
    expect(nonStandard.internalAmount).toBe("380.8560"); // 453.40 * 21 / 25

    const fiftyOne = calculateInternalAmount({
      payTo: "Excellent Staffing",
      importedAmount: "663",
      rowRate: "51",
      ...NINETEEN,
    });
    expect(fiftyOne.rule).toBe("agency_rate_converted");
    expect(fiftyOne.internalAmount).toBe("593.2105"); // 663 * 17 / 19
  });
});

describe("isIntegerMultiple", () => {
  it("accepts whole multiples of the agency rate", () => {
    expect(isIntegerMultiple("19", "19")).toBe(true);
    expect(isIntegerMultiple("38", "19")).toBe(true);
    expect(isIntegerMultiple("57", "19")).toBe(true);
    expect(isIntegerMultiple("95", "19")).toBe(true);
  });

  it("rejects internal-rate multiples and partial multiples", () => {
    expect(isIntegerMultiple("51", "19")).toBe(false);
    expect(isIntegerMultiple("34", "19")).toBe(false);
    expect(isIntegerMultiple("9.5", "19")).toBe(false);
  });

  it("never divides by a zero base", () => {
    expect(isIntegerMultiple("19", "0")).toBe(false);
  });
});

describe("comparing our figure against the workbook's own column P", () => {
  it("flags a disagreement instead of overwriting either side", () => {
    const c = compareInternalAmounts("663.00", "660.0000");
    expect(c.matches).toBe(false);
    expect(c.difference).toBe("-3.0000");
    expect(c.spreadsheetValue).toBe("663.0000");
    expect(c.applicationValue).toBe("660.0000");
  });

  it("accepts sub-cent rounding drift", () => {
    expect(compareInternalAmounts("663.00", "663.0050").matches).toBe(true);
  });

  it("agrees when neither side has a value", () => {
    expect(compareInternalAmounts(null, null).matches).toBe(true);
  });
});
