import JSZip from "jszip";
import { normalizeAhivimDates, parseWorkbook } from "@/lib/excel/parse-workbook";
import type { AhivimField } from "@/lib/excel/column-map";
import { dec, tryDec } from "@/lib/money";
import { normalizeAccountingNumber, parseCsv, parseSheetCsv, type SheetCsvParseResult } from "./parse-csv";

const MONEY_FIELDS: readonly AhivimField[] = [
  "hours", "rate", "amount", "totalNetPay", "calculatedInternalAmount",
];
const DATE_FIELDS: readonly AhivimField[] = ["checkDate", "periodBegin", "periodEnd"];
const DATE_DISPLAY = /^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/;

/** Only numeric source values in actual date columns are converted to dates. */
function serialDate(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const date = new Date((Math.floor(value) - 25_569) * 86_400_000);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getUTCFullYear();
  return year >= 1 && year <= 9999 ? date.toISOString().slice(0, 10) : null;
}

export function restoreSheetDateColumns(values: readonly (readonly unknown[])[]): unknown[][] {
  const copied = values.map((row) => [...row]);
  const parsed = parseSheetCsv(csvFromValues(copied));
  if (parsed.headerRowIndex === null) return copied;
  for (const row of parsed.ahivimRows) {
    const index = row.sourceRowNumber - 1;
    for (const field of DATE_FIELDS) {
      const column = parsed.columnMap[field] - 1;
      const value = copied[index]![column];
      if (typeof value === "number") copied[index]![column] = serialDate(value) ?? String(value);
    }
  }
  return copied;
}

export function csvFromValues(values: readonly (readonly unknown[])[]): string {
  return values.map((row) => row.map((value) => {
    const text = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value) : "";
    return `"${text.replace(/"/g, '""')}"`;
  }).join(",")).join("\n");
}

export function needsNumericSourceRecovery(parsed: SheetCsvParseResult): boolean {
  return parsed.ahivimRows.some((row) => MONEY_FIELDS.some((field) => DATE_DISPLAY.test(row.raw[field])));
}

function cellAddress(column: number, row: number): string {
  let letters = "";
  while (column > 0) {
    const digit = (column - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    column = Math.floor((column - 1) / 26);
  }
  return `${letters}${row}`;
}

/** Read numeric caches, including zero and exact fractions, without evaluating formulas. */
async function rawNumericCells(bytes: Buffer): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(bytes);
  const worksheets = zip.file(/^xl\/worksheets\/sheet\d+\.xml$/);
  if (worksheets.length !== 1) throw new Error("The numeric source must contain exactly the pinned transaction tab.");
  const xml = await worksheets[0]!.async("string");
  if (xml.length > 40_000_000) throw new Error("The numeric source exceeds the supported worksheet size.");
  const values = new Map<string, string>();
  for (const cell of xml.matchAll(/<c\b([^>]*?)(?<!\/)>([\s\S]*?)<\/c>/g)) {
    const address = /\br="([A-Z]+[1-9]\d*)"/.exec(cell[1]!)?.[1];
    const type = /\bt="([^"]+)"/.exec(cell[1]!)?.[1];
    if (!address || (type !== undefined && type !== "n")) continue;
    const value = /<v>([^<]*)<\/v>/.exec(cell[2]!)?.[1]?.trim();
    if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) continue;
    const number = tryDec(value);
    if (number?.isFinite()) values.set(address, number.toString());
  }
  return values;
}

function semanticValue(field: AhivimField, value: string, raw: Record<AhivimField, string>): string {
  if (value.trim() === "") return "";
  if (DATE_FIELDS.includes(field)) return normalizeAhivimDates(raw)[field] || value.trim();
  if (MONEY_FIELDS.includes(field) || field === "nonContractHeader" || field === "dedupNetPayFormula") {
    const number = tryDec(normalizeAccountingNumber(value));
    // Sheets stores IEEE-754 numbers. Ignore only serialization noise beyond
    // its 15 significant digits, never a change hidden by database rounding.
    if (number) return number.toSignificantDigits(15).toString();
  }
  return value.trim();
}

/**
 * Enrich only date-displayed numeric inputs. Every other mapped field and every
 * source row must agree across both reads. A changed snapshot aborts the sync.
 */
export async function recoverNumericSourceCsv(csv: string, bytes: Buffer, sheetName: string): Promise<string> {
  const source = parseSheetCsv(csv);
  const workbook = await parseWorkbook(bytes);
  if (workbook.sheets.length !== 1 || workbook.sheets[0]?.name !== sheetName
    || workbook.ahivimRows.length !== source.ahivimRows.length
    || JSON.stringify(workbook.columnMap) !== JSON.stringify(source.columnMap)) {
    throw new Error("The numeric source does not match the pinned transaction tab and row layout.");
  }
  const numbers = await rawNumericCells(bytes);
  const sourceByRow = new Map(source.ahivimRows.map((row) => [row.sourceRowNumber, row]));
  const grid = parseCsv(csv);
  for (const workbookRow of workbook.ahivimRows) {
    const row = sourceByRow.get(workbookRow.sourceRowNumber);
    if (!row) throw new Error("The Sheet changed between source reads. Retry the sync.");
    for (const field of Object.keys(source.columnMap) as AhivimField[]) {
      const address = cellAddress(workbook.columnMap[field], workbookRow.sourceRowNumber);
      const nativeNumber = numbers.get(address);
      const numericField = MONEY_FIELDS.includes(field) || field === "nonContractHeader" || field === "dedupNetPayFormula";
      const workbookValue = numericField && nativeNumber !== undefined ? nativeNumber : workbookRow.raw[field];
      if (MONEY_FIELDS.includes(field) && DATE_DISPLAY.test(row.raw[field]) && nativeNumber !== undefined) {
        // Original numeric XML, never a guessed inverse of the CSV's date text.
        grid[row.sourceRowNumber - 1]![source.columnMap[field] - 1] = dec(nativeNumber).toString();
      } else if (semanticValue(field, row.raw[field], row.raw)
        !== semanticValue(field, workbookValue, workbookRow.raw)) {
        throw new Error(`The Sheet changed between source reads at row ${row.sourceRowNumber} (${field}). Retry the sync.`);
      }
    }
  }
  return csvFromValues(grid);
}
