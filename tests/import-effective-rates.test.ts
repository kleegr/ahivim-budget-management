import { describe, expect, it } from "vitest";
import type { AhivimRow } from "@/lib/excel/column-map";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";
import {
  rateConfigForStagedRow,
  stageRows,
  type StagingContext,
} from "@/lib/import/stage";

function sourceRow(
  sourceRowNumber: number,
  overrides: Partial<AhivimRow> = {},
): ParsedAhivimRow {
  const parsed: AhivimRow = {
    payTo: "Excellent Staffing",
    checkDate: "",
    checkNumber: `CHK-${sourceRowNumber}`,
    code: "",
    hours: "4",
    rate: "25",
    amount: "100",
    totalNetPay: "",
    periodBegin: "",
    periodEnd: "",
    programDescription: "Respite",
    individual: `Person ${sourceRowNumber}`,
    employee: `Employee ${sourceRowNumber}`,
    nonContractHeader: "",
    calculatedInternalAmount: "",
    dedupNetPayFormula: "",
    paid: "",
    ...overrides,
  };
  return {
    sourceRowNumber,
    raw: { ...parsed },
    formulas: {},
    parsed,
    errors: [],
  };
}

function baseContext(): StagingContext {
  return {
    ratesByProgram: {
      RESPITE: { agencyRate: "99", internalRate: "98" },
    },
    individuals: [],
    individualAliases: [],
    employees: [],
    employeeAliases: [],
    knownFingerprints: new Set(),
    knownNaturalKeys: new Set(),
  };
}

describe("import effective-dated rates", () => {
  it("resolves each row on period begin, then check date, then period end", () => {
    const context: StagingContext = {
      ...baseContext(),
      rateFallbackDate: "2026-08-30",
      rateSchedulesByProgram: {
        RESPITE: [
          {
            effectiveFrom: "2024-01-01",
            effectiveTo: "2024-12-31",
            agencyRate: "25",
            internalRate: "21",
          },
          {
            effectiveFrom: "2025-01-01",
            effectiveTo: "2029-12-31",
            agencyRate: "30",
            internalRate: "24",
          },
          {
            effectiveFrom: "2030-01-01",
            effectiveTo: null,
            agencyRate: "35",
            internalRate: "28",
          },
        ],
      },
    };

    const result = stageRows([
      sourceRow(1, {
        periodBegin: "2024-06-01",
        checkDate: "2030-06-15",
        periodEnd: "2030-06-30",
        rate: "25",
      }),
      sourceRow(2, {
        checkDate: "2030-06-15",
        periodEnd: "2024-06-30",
        rate: "35",
      }),
      sourceRow(3, { rate: "30" }),
      sourceRow(4, { periodBegin: "2010-01-01" }),
    ], context);

    expect(result.rows.map((row) => ({
      date: row.rateResolvedForDate,
      agency: row.agencyRateApplied,
      internal: row.internalRateApplied,
      amount: row.calculatedInternalAmount,
    }))).toEqual([
      { date: "2024-06-01", agency: "25.0000", internal: "21.0000", amount: "84.0000" },
      { date: "2030-06-15", agency: "35.0000", internal: "28.0000", amount: "80.0000" },
      { date: "2026-08-30", agency: "30.0000", internal: "24.0000", amount: "80.0000" },
      { date: "2010-01-01", agency: null, internal: null, amount: "100.0000" },
    ]);
  });

  it("keeps the current-rate context compatible for lightweight fixtures", () => {
    const result = stageRows([
      sourceRow(1, { periodBegin: "2001-01-01", rate: "99" }),
    ], baseContext());

    expect(result.rows[0]).toMatchObject({
      agencyRateApplied: "99",
      internalRateApplied: "98",
      calculatedInternalAmount: "98.9899",
    });
  });

  it("pins an explicit historical rate and never replaces an absent old rate with today's", () => {
    const current = { agencyRate: "99", internalRate: "98" };

    expect(rateConfigForStagedRow({
      agencyRateApplied: "25.0000",
      internalRateApplied: "21.0000",
    }, current)).toEqual({ agencyRate: "25.0000", internalRate: "21.0000" });
    expect(rateConfigForStagedRow({
      agencyRateApplied: null,
      internalRateApplied: null,
    }, current)).toBeUndefined();
    expect(rateConfigForStagedRow({}, current)).toEqual(current);
  });
});
