import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseWorkbook } from "@/lib/excel/parse-workbook";

const HEADERS = [
  "Pay to",
  "Check Date",
  "Check Number",
  "Code",
  "Hours",
  "Rate",
  "Amount",
  "Total Net Pay",
  "Period Begin",
  "Period End",
  "Paid CC2 Description",
  "Paid CC3 Description",
  "Employee Memo",
  "",
  "Non contract",
  "Internal Amount",
  "",
  "",
  "Deduplicated Net Pay",
];

async function workbookWithDateFormattedMoney(date1904: boolean): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.properties.date1904 = date1904;
  const sheet = workbook.addWorksheet("Ahivim");

  sheet.getCell("P1").value = 210;
  sheet.getCell("Q1").value = 250;
  sheet.getCell("R1").value = 40;
  sheet.getCell("S1").value = 3172.03;
  sheet.getCell("S1").numFmt = "m/d/yyyy";

  HEADERS.forEach((header, index) => {
    sheet.getRow(2).getCell(index + 1).value = header;
  });

  const row = sheet.getRow(3);
  row.getCell(1).value = "Employee One";
  row.getCell(2).value = new Date(Date.UTC(2026, 7, 15));
  row.getCell(2).numFmt = "m/d/yyyy";
  row.getCell(3).value = "CHECK-1";
  row.getCell(4).value = "RG";
  row.getCell(5).value = 10;
  row.getCell(6).value = 25;
  row.getCell(7).value = 250;
  row.getCell(8).value = 3172.03;
  row.getCell(8).numFmt = "m/d/yyyy";
  row.getCell(9).value = new Date(Date.UTC(2026, 7, 1));
  row.getCell(9).numFmt = "m/d/yyyy";
  row.getCell(10).value = new Date(Date.UTC(2026, 7, 15));
  row.getCell(10).numFmt = "m/d/yyyy";
  row.getCell(11).value = "Com Hab";
  row.getCell(12).value = "Individual One";
  row.getCell(13).value = "Employee One";
  row.getCell(16).value = 210;
  row.getCell(19).value = { formula: "3000+172.03", result: 3172.03 };
  row.getCell(19).numFmt = "m/d/yyyy";

  const output = await workbook.xlsx.writeBuffer();
  return Buffer.from(output);
}

describe("Ahivim workbook field-aware parsing", () => {
  it.each([false, true])(
    "recovers money cells with an accidental date format (date1904=%s)",
    async (date1904) => {
      const parsed = await parseWorkbook(await workbookWithDateFormattedMoney(date1904));
      const row = parsed.ahivimRows[0];

      expect(row?.errors).toEqual([]);
      expect(row?.raw.totalNetPay).toBe("3172.03");
      expect(row?.parsed?.totalNetPay).toBe("3172.03");
      expect(row?.raw.dedupNetPayFormula).toBe("3172.03");
      expect(row?.parsed?.dedupNetPayFormula).toBe("3172.03");
      expect(parsed.controlTotals.deduplicatedNetPay).toBe("3172.03");
      expect(parsed.warnings).toContain(
        "Recovered numeric values from cells that were accidentally formatted as dates: " +
          "1 Total Net Pay, 1 Deduplicated Net Pay.",
      );
    },
  );

  it("keeps genuine date columns as ISO dates", async () => {
    const parsed = await parseWorkbook(await workbookWithDateFormattedMoney(false));
    const row = parsed.ahivimRows[0];

    expect(row?.parsed?.checkDate).toBe("2026-08-15");
    expect(row?.parsed?.periodBegin).toBe("2026-08-01");
    expect(row?.parsed?.periodEnd).toBe("2026-08-15");
  });
});
