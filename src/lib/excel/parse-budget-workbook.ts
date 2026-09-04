import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { normalizePersonName } from "@/lib/business/name-matching";
import { tryDec, toHours } from "@/lib/money";
import { deriveAnnualPeriodFromRenewal } from "@/lib/manage/budget-periods";

/**
 * Fixed, reviewed map for Budget copy.xlsx!UpToDate.
 *
 * Billed columns are read only to identify billing-without-budget exceptions.
 * "What's Left" columns are deliberately absent from this map: they are
 * formulas/derived comparisons and must never become authorization truth.
 */
export const BUDGET_WORKBOOK_SHEET = "UpToDate";
export const BUDGET_WORKBOOK_FIRST_ROW = 3;
export const BUDGET_WORKBOOK_LAST_ROW = 40;

export const BUDGET_WORKBOOK_PROGRAM_COLUMNS = [
  { programCode: "COM_HAB", programLabel: "Com Hab", billedColumn: 3, originalColumn: 4 },
  { programCode: "RESPITE", programLabel: "Respite", billedColumn: 6, originalColumn: 7 },
  { programCode: "SH_COM_HAB", programLabel: "Self-Hired Com Hab", billedColumn: 9, originalColumn: 10 },
  { programCode: "SH_RESPITE", programLabel: "Self-Hired Respite", billedColumn: 12, originalColumn: 13 },
  { programCode: "DAY_HAB", programLabel: "Day Hab", billedColumn: 15, originalColumn: 16 },
  {
    programCode: "SUPP_GROUP_DAY_HAB",
    programLabel: "Supplemental Group Day Hab",
    billedColumn: 18,
    originalColumn: 19,
  },
] as const;

export type BudgetWorkbookProgramCode =
  (typeof BUDGET_WORKBOOK_PROGRAM_COLUMNS)[number]["programCode"];

export interface BudgetWorkbookCellIssue {
  code: string;
  message: string;
}

export interface ParsedBudgetAuthorization {
  programCode: BudgetWorkbookProgramCode;
  programLabel: string;
  sourceCell: string;
  billedComparisonCell: string;
  /** The only workbook value eligible to become authorization truth. */
  authorizedHours: string | null;
  /** Comparison-only; this value is never sent to an authorization insert. */
  billedComparisonHours: string | null;
  billingWithoutBudget: boolean;
  originalWasFormula: boolean;
  issues: BudgetWorkbookCellIssue[];
}

export interface ParsedBudgetRow {
  sourceRowNumber: number;
  sourceRowHidden: boolean;
  sourceIndividualLabel: string;
  normalizedIndividualLabel: string;
  renewalDate: string | null;
  periodStartDate: string | null;
  periodEndDate: string | null;
  sourceKey: string;
  authorizations: ParsedBudgetAuthorization[];
  issues: BudgetWorkbookCellIssue[];
}

export interface BudgetWorkbookParseResult {
  sourceFileName: string;
  checksumSha256: string;
  sourceSheetName: typeof BUDGET_WORKBOOK_SHEET;
  sourceRange: string;
  layoutValid: boolean;
  rows: ParsedBudgetRow[];
  warnings: string[];
  summary: {
    sourceRows: number;
    distinctNormalizedPeople: number;
    distinctSourceKeys: number;
    sourceAuthorizations: number;
    billingWithoutBudget: number;
    hiddenRows: number[];
  };
}

function columnLetter(column: number): string {
  let value = column;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function formulaResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if ("formula" in record || "sharedFormula" in record) return record.result ?? null;
  return value;
}

function isFormula(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return "formula" in record || "sharedFormula" in record;
}

function cellText(cell: ExcelJS.Cell, trim = true): string {
  const value = formulaResult(cell.value);
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    return trim ? text.trim() : text;
  }
  if (typeof value === "object" && "text" in value) {
    const text = String((value as { text?: unknown }).text ?? "");
    return trim ? text.trim() : text;
  }
  return trim ? cell.text.trim() : cell.text;
}

function validDateParts(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() + 1 === month
    && candidate.getUTCDate() === day;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (!validDateParts(year, month, day)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function excelSerialDate(value: number, date1904: boolean): string | null {
  if (!Number.isFinite(value) || value < 1) return null;
  const unixDays = Math.floor(value) - 25_569 + (date1904 ? 1_462 : 0);
  const date = new Date(unixDays * 86_400_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function parseDateCell(cell: ExcelJS.Cell, date1904: boolean): string | null {
  const value = formulaResult(cell.value);
  if (value instanceof Date) {
    return isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === "number") return excelSerialDate(value, date1904);
  const text = cellText(cell);
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) return isoDate(Number(match[3]), Number(match[1]), Number(match[2]));
  return null;
}

function parseHoursCell(cell: ExcelJS.Cell): {
  value: string | null;
  issues: BudgetWorkbookCellIssue[];
} {
  const text = cellText(cell);
  if (text === "") return { value: null, issues: [] };
  const parsed = tryDec(text);
  if (!parsed || parsed.isNegative()) {
    return {
      value: null,
      issues: [{ code: "invalid_authorized_hours", message: "Original authorization must be a non-negative number of hours." }],
    };
  }
  if (parsed.decimalPlaces() > 4 || parsed.gt("999999.9999")) {
    return {
      value: null,
      issues: [{
        code: "authorized_hours_out_of_range",
        message: "Original authorization exceeds the database precision for hours and needs owner review.",
      }],
    };
  }
  return { value: toHours(parsed), issues: [] };
}

function parseComparisonHours(cell: ExcelJS.Cell): string | null {
  const text = cellText(cell);
  if (text === "") return null;
  const parsed = tryDec(text);
  return parsed && parsed.isFinite() ? parsed.toString() : null;
}

function normalizedHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function validateLayout(sheet: ExcelJS.Worksheet): string[] {
  const issues: string[] = [];
  if (normalizedHeader(cellText(sheet.getCell("A1"))) !== "individual") {
    issues.push("Expected Individual in UpToDate!A1.");
  }
  if (normalizedHeader(cellText(sheet.getCell("B1"))) !== "renewal date") {
    issues.push("Expected Renewal Date in UpToDate!B1.");
  }
  for (const spec of BUDGET_WORKBOOK_PROGRAM_COLUMNS) {
    const main = normalizedHeader(cellText(sheet.getRow(1).getCell(spec.originalColumn)));
    const sub = normalizedHeader(cellText(sheet.getRow(2).getCell(spec.originalColumn)));
    const acceptedMain = new Set([
      normalizedHeader(spec.programLabel),
      normalizedHeader(spec.programLabel.replace("Self-Hired", "SD - Self Hired")),
    ]);
    if (!acceptedMain.has(main) || sub !== "original") {
      issues.push(
        `Expected ${spec.programLabel} / original in ${columnLetter(spec.originalColumn)}1:${columnLetter(spec.originalColumn)}2.`,
      );
    }
  }
  return issues;
}

function rowHasSourceContent(row: ExcelJS.Row): boolean {
  for (let column = 1; column <= 19; column += 1) {
    if (row.getCell(column).value !== null) return true;
  }
  return false;
}

/** Parse only the reviewed source range. The workbook is never modified. */
export async function parseBudgetWorkbook(
  bytes: Buffer,
  sourceFileName: string,
): Promise<BudgetWorkbookParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.worksheets.find(
    (candidate) => candidate.name.trim().toLowerCase() === BUDGET_WORKBOOK_SHEET.toLowerCase(),
  );
  if (!sheet) throw new Error(`Sheet "${BUDGET_WORKBOOK_SHEET}" was not found in the Budget workbook.`);

  const warnings = validateLayout(sheet);
  const unexpectedRows: number[] = [];
  for (let rowNumber = BUDGET_WORKBOOK_LAST_ROW + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    if (rowHasSourceContent(sheet.getRow(rowNumber))) unexpectedRows.push(rowNumber);
  }
  if (unexpectedRows.length > 0) {
    warnings.push(
      `Non-empty rows outside the reviewed source range were not parsed: ${unexpectedRows.slice(0, 10).join(", ")}${unexpectedRows.length > 10 ? ", ..." : ""}.`,
    );
  }

  const date1904 = workbook.properties.date1904 === true;
  const rows: ParsedBudgetRow[] = [];
  for (let rowNumber = BUDGET_WORKBOOK_FIRST_ROW; rowNumber <= BUDGET_WORKBOOK_LAST_ROW; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!rowHasSourceContent(row)) continue;

    const sourceIndividualLabel = cellText(row.getCell(1), false);
    const normalizedIndividualLabel = normalizePersonName(sourceIndividualLabel);
    const renewalDate = parseDateCell(row.getCell(2), date1904);
    const issues: BudgetWorkbookCellIssue[] = [];
    if (!normalizedIndividualLabel) {
      issues.push({ code: "missing_individual", message: "The source individual label is blank." });
    }
    if (!renewalDate) {
      issues.push({ code: "invalid_renewal_date", message: "Renewal must be a real spreadsheet date." });
    }

    let periodStartDate: string | null = null;
    let periodEndDate: string | null = null;
    if (renewalDate) {
      try {
        ({ startDate: periodStartDate, endDate: periodEndDate } = deriveAnnualPeriodFromRenewal(renewalDate));
      } catch (error) {
        issues.push({
          code: "invalid_renewal_date",
          message: error instanceof Error ? error.message : "Renewal could not be converted to an annual service period.",
        });
      }
    }

    const authorizations = BUDGET_WORKBOOK_PROGRAM_COLUMNS.map((spec): ParsedBudgetAuthorization => {
      const originalCell = row.getCell(spec.originalColumn);
      const billedCell = row.getCell(spec.billedColumn);
      const parsedOriginal = parseHoursCell(originalCell);
      const billedComparisonHours = parseComparisonHours(billedCell);
      const originalWasFormula = isFormula(originalCell.value);
      const authorizationIssues = [...parsedOriginal.issues];
      if (originalWasFormula) {
        authorizationIssues.push({
          code: "formula_in_original_column",
          message: "An Original authorization cell contains a formula; its cached result cannot be imported automatically.",
        });
      }
      return {
        programCode: spec.programCode,
        programLabel: spec.programLabel,
        sourceCell: `${columnLetter(spec.originalColumn)}${rowNumber}`,
        billedComparisonCell: `${columnLetter(spec.billedColumn)}${rowNumber}`,
        authorizedHours: parsedOriginal.value,
        billedComparisonHours,
        billingWithoutBudget: parsedOriginal.value === null
          && billedComparisonHours !== null
          && !tryDec(billedComparisonHours)?.isZero(),
        originalWasFormula,
        issues: authorizationIssues,
      };
    });

    rows.push({
      sourceRowNumber: rowNumber,
      sourceRowHidden: row.hidden === true,
      sourceIndividualLabel,
      normalizedIndividualLabel,
      renewalDate,
      periodStartDate,
      periodEndDate,
      sourceKey: `${normalizedIndividualLabel}|${renewalDate ?? "invalid-renewal"}`,
      authorizations,
      issues,
    });
  }

  const people = new Set(rows.map((row) => row.normalizedIndividualLabel).filter(Boolean));
  const keys = new Set(rows.map((row) => row.sourceKey));
  const sourceAuthorizations = rows.flatMap((row) => row.authorizations)
    .filter((authorization) => authorization.authorizedHours !== null).length;
  const billingWithoutBudget = rows.flatMap((row) => row.authorizations)
    .filter((authorization) => authorization.billingWithoutBudget).length;
  const hiddenRows = rows.filter((row) => row.sourceRowHidden).map((row) => row.sourceRowNumber);

  return {
    sourceFileName: sourceFileName.trim() || "Budget workbook",
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceSheetName: BUDGET_WORKBOOK_SHEET,
    sourceRange: `${BUDGET_WORKBOOK_SHEET}!A${BUDGET_WORKBOOK_FIRST_ROW}:S${BUDGET_WORKBOOK_LAST_ROW}`,
    layoutValid: warnings.length === 0,
    rows,
    warnings,
    summary: {
      sourceRows: rows.length,
      distinctNormalizedPeople: people.size,
      distinctSourceKeys: keys.size,
      sourceAuthorizations,
      billingWithoutBudget,
      hiddenRows,
    },
  };
}
