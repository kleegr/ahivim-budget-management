import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseCalculationsWorkbook } from "@/lib/excel/parse-calculations-workbook";

function addReviewedHeaders(sheet: ExcelJS.Worksheet): void {
  const headers: Record<number, string> = {
    5: "1st %",
    6: "2nd %",
    7: "Clock",
    8: "Adjustments",
    9: "ComHab",
    10: "Respite",
    11: "SHCH",
    12: "SHR",
    13: "DayHab",
    14: "SDH",
    16: "Yearly Gross",
    17: "Monthly Gross",
    18: "Gross Net",
    19: "Net",
    20: "After All",
  };
  for (const [column, label] of Object.entries(headers)) {
    sheet.getRow(1).getCell(Number(column)).value = label;
  }
  sheet.getCell("C2").value = "Rates";
  [21, 17, 38, 18, 17, 17].forEach((rate, index) => {
    sheet.getRow(2).getCell(9 + index).value = rate;
  });
}

function addNormalRow(sheet: ExcelJS.Worksheet): void {
  sheet.getCell("C5").value = "Avery Sample 2";
  sheet.getCell("D5").value = new Date(Date.UTC(2026, 0, 1));
  sheet.getCell("E5").value = 25;
  sheet.getCell("G5").value = -100;
  sheet.getCell("H5").value = 1200;
  sheet.getCell("M5").value = 1075;
  sheet.getCell("P5").value = { formula: "N5*N$2+M5*M$2+L5*L$2+K5*K$2+J5*J$2+I5*I$2", result: 18275 };
  sheet.getCell("Q5").value = { formula: "P5/12", result: 1522.916667 };
  sheet.getCell("R5").value = {
    formula: "Q5-(Q5*E5/100)-((Q5-(Q5*E5/100))*F5/100)",
    result: 1142.1875,
  };
  sheet.getCell("S5").value = { formula: "SUM(R5,G5:H5)", result: 2242.1875 };
  sheet.getCell("T5").value = 2240;
  sheet.getCell("U5").value = "C";
  sheet.getCell("V5").value = "Approved arrangement";
  sheet.getCell("W5").value = "845-555-0100";
}

function addShiftedRow(sheet: ExcelJS.Worksheet): void {
  sheet.getCell("C13").value = "Shifted Example";
  sheet.getCell("D13").value = 25;
  sheet.getCell("D13").numFmt = "m/d/yyyy";
  sheet.getCell("F13").value = -125;
  sheet.getCell("M13").value = 1075;
  sheet.getCell("N13").value = 250;
  sheet.getCell("P13").value = {
    formula: "N13*N$2+M13*M$2+L13*L$2+K13*K$2+J13*J$2+I13*I$2+H13*H$2",
    result: 22525,
  };
  sheet.getCell("Q13").value = { formula: "P13/7", result: 3217.857143 };
  sheet.getCell("R13").value = {
    formula: "Q13-(Q13*D13/100)-((Q13-(Q13*D13/100))*E13/100)",
    result: 2413.392857,
  };
  sheet.getCell("S13").value = { formula: "SUM(R13,F13:G13)", result: 2288.392857 };
  sheet.getCell("T13").value = 2280;
  sheet.getCell("U13").value = "Account";
}

function addPlaceholderRow(sheet: ExcelJS.Worksheet): void {
  sheet.getCell("C30").value = "placeholder Example";
  sheet.getCell("E30").value = "X";
  sheet.getCell("F30").value = "X";
}

async function fixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Ahivim");
  addReviewedHeaders(sheet);
  addNormalRow(sheet);
  addShiftedRow(sheet);
  addPlaceholderRow(sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("Calculations workbook parser", () => {
  it("detects the real column-C layout and keeps strategy suffixes off the person", async () => {
    const parsed = await parseCalculationsWorkbook(await fixture(), "calculations.xlsx");
    const row = parsed.rows.find((candidate) => candidate.sourceRowNumber === 5)!;

    expect(parsed.layoutValid).toBe(true);
    expect(parsed.sourceSheetName).toBe("Ahivim");
    expect(parsed.sourceRateHints).toMatchObject({ COM_HAB: "21", SH_COM_HAB: "38" });
    expect(row.individualMatchLabel).toBe("Avery Sample");
    expect(row.normalizedIndividualLabel).toBe("avery sample");
    expect(row.strategyLabel).toBe("2");
    expect(row.renewalDate).toBe("2026-01-01");
    expect(row.monthDivisor).toBe("12.000");
    expect(row.cut1Percent).toBe("0.250000");
    expect(row.cut2Percent).toBe("0.000000");
    expect(row.otherAdjustment).toBe("1200.0000");
    expect(row.sourceResults.afterAll).toBe("2240.0000");
    expect(row.notes).toBe("Approved arrangement");
    expect(row.phone).toBe("845-555-0100");
    expect(row.issues).toEqual([]);
  });

  it("recovers but blocks the shifted synthetic row with its 7-month divisor", async () => {
    const parsed = await parseCalculationsWorkbook(await fixture(), "calculations.xlsx");
    const row = parsed.rows.find((candidate) => candidate.sourceRowNumber === 13)!;

    expect(row.renewalDate).toBeNull();
    expect(row.monthDivisor).toBe("7.000");
    expect(row.cut1Percent).toBe("0.250000");
    expect(row.cut2Percent).toBe("0.000000");
    expect(row.clockAdjustment).toBe("-125.0000");
    expect(row.issues.map((issue) => issue.code)).toContain("structurally_shifted_row");
  });

  it("preserves the X/X synthetic placeholder as review-only", async () => {
    const parsed = await parseCalculationsWorkbook(await fixture(), "calculations.xlsx");
    const row = parsed.rows.find((candidate) => candidate.sourceRowNumber === 30)!;

    expect(row.issues.map((issue) => issue.code)).toContain("placeholder_row");
    expect(row.sourceSnapshot).toBeTruthy();
    expect(parsed.summary).toMatchObject({ sourceRows: 3, reviewRows: 2 });
  });
});
