import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  BUDGET_WORKBOOK_PROGRAM_COLUMNS,
  parseBudgetWorkbook,
} from "@/lib/excel/parse-budget-workbook";

function addReviewedHeaders(sheet: ExcelJS.Worksheet): void {
  sheet.getCell("A1").value = "Individual";
  sheet.getCell("B1").value = "Renewal Date";
  for (const spec of BUDGET_WORKBOOK_PROGRAM_COLUMNS) {
    const sourceLabel = spec.programCode === "SH_COM_HAB"
      ? "SD - Self Hired Com Hab"
      : spec.programCode === "SH_RESPITE"
        ? "SD - Self Hired Respite"
        : spec.programLabel;
    sheet.getRow(1).getCell(spec.originalColumn).value = sourceLabel;
    sheet.getRow(2).getCell(spec.originalColumn).value = "original";
    sheet.getRow(2).getCell(spec.billedColumn).value = "Billed";
  }
}

async function workbookBytes(build: (sheet: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("UpToDate");
  addReviewedHeaders(sheet);
  build(sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("Budget workbook parser", () => {
  it("maps only Original columns and marks billed-without-budget as comparison-only", async () => {
    const bytes = await workbookBytes((sheet) => {
      sheet.getCell("A3").value = "  Person, One  ";
      sheet.getCell("B3").value = new Date(Date.UTC(2027, 0, 1));
      sheet.getCell("C3").value = { formula: "SUM(1,2)", result: 3 };
      sheet.getCell("D3").value = 416;
      sheet.getCell("F3").value = { formula: "SUM(30,5.91)", result: 35.91 };
      sheet.getCell("G3").value = null;
      // These derived cells must never be read as authorization inputs.
      sheet.getCell("E3").value = 999_999;
      sheet.getCell("H3").value = 888_888;
    });

    const parsed = await parseBudgetWorkbook(bytes, "Budget source.xlsx");
    const row = parsed.rows[0]!;
    const comHab = row.authorizations.find((authorization) => authorization.programCode === "COM_HAB")!;
    const respite = row.authorizations.find((authorization) => authorization.programCode === "RESPITE")!;

    expect(parsed.layoutValid).toBe(true);
    expect(parsed.summary).toMatchObject({
      sourceRows: 1,
      distinctNormalizedPeople: 1,
      distinctSourceKeys: 1,
      sourceAuthorizations: 1,
      billingWithoutBudget: 1,
    });
    expect(row).toMatchObject({
      sourceIndividualLabel: "  Person, One  ",
      normalizedIndividualLabel: "one person",
      renewalDate: "2027-01-01",
      periodStartDate: "2026-01-01",
      periodEndDate: "2026-12-31",
    });
    expect(comHab).toMatchObject({
      sourceCell: "D3",
      authorizedHours: "416.0000",
      billedComparisonHours: "3",
      billingWithoutBudget: false,
    });
    expect(respite).toMatchObject({
      sourceCell: "G3",
      authorizedHours: null,
      billedComparisonHours: "35.91",
      billingWithoutBudget: true,
    });
    expect(row.authorizations.some((authorization) => authorization.authorizedHours === "999999.0000")).toBe(false);
    expect(row.authorizations.some((authorization) => authorization.authorizedHours === "888888.0000")).toBe(false);
  });

  it("keeps a hidden source row visible but makes the fact explicit", async () => {
    const bytes = await workbookBytes((sheet) => {
      sheet.getCell("A7").value = "Hidden Person";
      sheet.getCell("B7").value = new Date(Date.UTC(2027, 1, 1));
      sheet.getCell("J7").value = 542;
      sheet.getRow(7).hidden = true;
    });

    const parsed = await parseBudgetWorkbook(bytes, "Budget source.xlsx");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      sourceRowNumber: 7,
      sourceRowHidden: true,
      renewalDate: "2027-02-01",
      periodStartDate: "2026-02-01",
      periodEndDate: "2027-01-31",
    });
    expect(parsed.summary.hiddenRows).toEqual([7]);
  });

  it("does not trust formula-driven Original hours or an altered layout", async () => {
    const bytes = await workbookBytes((sheet) => {
      sheet.getCell("A1").value = "Renamed field";
      sheet.getCell("A3").value = "Formula Person";
      sheet.getCell("B3").value = "1/1/2027";
      sheet.getCell("D3").value = { formula: "200+216", result: 416 };
    });

    const parsed = await parseBudgetWorkbook(bytes, "Budget source.xlsx");
    expect(parsed.layoutValid).toBe(false);
    expect(parsed.warnings).toContain("Expected Individual in UpToDate!A1.");
    expect(parsed.rows[0]?.authorizations[0]).toMatchObject({
      authorizedHours: "416.0000",
      originalWasFormula: true,
      issues: [{ code: "formula_in_original_column" }],
    });
  });
});
