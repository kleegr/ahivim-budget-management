import { describe, expect, it } from "vitest";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";
import {
  sheetSourceIdentity,
  sourceEvidenceKey,
} from "@/lib/sheets/identity";

const BASE = {
  payTo: "Excellent Staffing",
  checkNumber: "1001",
  checkDate: "2026-08-21",
  program: "Com Hab",
  individual: "Test Individual",
  employee: "Test Employee",
  periodBegin: "2026-08-01",
  periodEnd: "2026-08-15",
  hours: "10",
  rate: "25",
  amount: "250",
  totalNetPay: "1,000.00",
  sourcePaid: false,
};

describe("versioned Sheet source evidence identity", () => {
  it("preserves normalized, readable Pay To and Total Net Pay evidence", () => {
    const parsed = {
      sourceRowNumber: 3,
      raw: {} as ParsedAhivimRow["raw"],
      formulas: {},
      errors: [],
      parsed: {
        payTo: "  Excellent   Staffing  ",
        checkDate: "2026-08-21",
        checkNumber: "1001",
        code: "RG",
        hours: "10",
        rate: "25",
        amount: "250",
        totalNetPay: "$1,000.00",
        periodBegin: "2026-08-01",
        periodEnd: "2026-08-15",
        programDescription: "Com Hab",
        individual: "Test Individual",
        employee: "Test Employee",
        nonContractHeader: "",
        calculatedInternalAmount: "210",
        dedupNetPayFormula: "",
        paid: "Paid",
      },
    } satisfies ParsedAhivimRow;

    expect(sheetSourceIdentity(parsed)).toMatchObject({
      payTo: "Excellent Staffing",
      totalNetPay: "1000.0000",
      sourcePaid: true,
    });
  });

  it("distinguishes a Pay-To-only difference", () => {
    expect(sourceEvidenceKey(BASE)).not.toBe(
      sourceEvidenceKey({ ...BASE, payTo: "Direct Employee" }),
    );
  });

  it("distinguishes a source-net-only difference", () => {
    expect(sourceEvidenceKey(BASE)).not.toBe(
      sourceEvidenceKey({ ...BASE, totalNetPay: "999.99" }),
    );
  });

  it("ignores Paid-only changes", () => {
    expect(sourceEvidenceKey(BASE)).toBe(
      sourceEvidenceKey({ ...BASE, sourcePaid: true }),
    );
  });

  it("ignores canonical figure changes because they are reviewed separately", () => {
    const key = sourceEvidenceKey(BASE);
    expect(key).toBe(sourceEvidenceKey({
      ...BASE,
      hours: "99",
      rate: "31.25",
      amount: "3093.75",
    }));
  });

  it("normalizes equivalent numeric and text display forms", () => {
    const key = sourceEvidenceKey(BASE);
    expect(key).toMatch(/^sheet-source-evidence:v2:/);
    expect(key).toBe(sourceEvidenceKey({
      ...BASE,
      payTo: "  excellent   staffing ",
      hours: "10.0000",
      rate: "$25.000",
      amount: "250.0000",
      totalNetPay: "1 000.0000",
    }));
  });
});
