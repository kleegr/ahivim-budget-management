import ExcelJS from "exceljs";
import { sheetValuesToCsv } from "@/lib/sheets/fetch";

export async function numericSheetFixture(options: {
  editWorkbook?: (sheet: ExcelJS.Worksheet) => void;
  sheetName?: string;
} = {}) {
  const totals = new Array<string>(19).fill("");
  const header = new Array<string>(19).fill("");
  header[0] = "Pay to"; header[3] = "Code";
  header[10] = "Paid CC2 Description"; header[11] = "Paid CC3 Description";
  header[12] = "Employee Memo"; header[13] = "Paid";
  const row = new Array<string>(19).fill("");
  row[0] = "Synthetic Numeric Employee";
  row[1] = "08/21/2026"; row[2] = "NUMERIC-SOURCE-1";
  row[4] = "100"; row[5] = "38"; row[6] = "3800";
  row[7] = "9/6/1908"; row[8] = "08/01/2026"; row[9] = "08/15/2026";
  row[10] = "SD - Self Hired Com Hab"; row[11] = "Synthetic Numeric Individual";
  row[12] = "Synthetic Numeric Employee"; row[15] = "0";
  const unknown = [...row];
  unknown[2] = "NUMERIC-SOURCE-UNKNOWN";
  unknown[7] = "Review original check";
  const values = [totals, header, [], row, unknown];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(options.sheetName ?? "Ahivim");
  for (let index = 0; index < values.length; index += 1) {
    sheet.getRow(index + 1).values = values[index]!;
  }
  sheet.getCell("H4").value = 3172.03;
  sheet.getCell("H4").numFmt = "mm-dd-yy";
  // A blank self-closing cell must not inherit the following cached zero.
  sheet.getCell("O4").value = null;
  sheet.getCell("O4").numFmt = "0.00";
  sheet.getCell("P4").value = { formula: "IFERROR(NA(),0)", result: 0 };
  sheet.getRow(4).hidden = true;
  options.editWorkbook?.(sheet);
  return { csv: sheetValuesToCsv(values), values, bytes: Buffer.from(await workbook.xlsx.writeBuffer()) };
}
