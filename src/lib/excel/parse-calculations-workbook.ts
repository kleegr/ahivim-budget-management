import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { normalizePersonName } from "@/lib/business/name-matching";
import { dec, toHours, toMoney, tryDec } from "@/lib/money";

/** The six source columns are hours only. Workbook rates are audit hints. */
export const CALCULATION_WORKBOOK_PROGRAM_HEADERS = [
  { programCode: "COM_HAB", header: "ComHab" },
  { programCode: "RESPITE", header: "Respite" },
  { programCode: "SH_COM_HAB", header: "SHCH" },
  { programCode: "SH_RESPITE", header: "SHR" },
  { programCode: "DAY_HAB", header: "DayHab" },
  { programCode: "SUPP_GROUP_DAY_HAB", header: "SDH" },
] as const;

export type CalculationWorkbookProgramCode =
  (typeof CALCULATION_WORKBOOK_PROGRAM_HEADERS)[number]["programCode"];

export interface CalculationWorkbookIssue {
  code: string;
  message: string;
  cell?: string;
}

export interface CalculationWorkbookSourceCell {
  address: string;
  text: string;
  value: string | number | boolean | null;
  formula: string | null;
  result: string | number | boolean | null;
}

export interface ParsedCalculationProgramHours {
  programCode: CalculationWorkbookProgramCode;
  sourceCell: string;
  authorizedHours: string | null;
  sourceFormula: string | null;
}

export interface CalculationWorkbookSourceResults {
  yearlyGross: string | null;
  monthlyGross: string | null;
  grossNet: string | null;
  net: string | null;
  afterAll: string | null;
}

export interface ParsedCalculationWorkbookRow {
  sourceRowNumber: number;
  sourceIndividualLabel: string;
  individualMatchLabel: string;
  normalizedIndividualLabel: string;
  strategyLabel: string;
  sourceKey: string;
  renewalDate: string | null;
  monthDivisor: string | null;
  cut1Percent: string | null;
  cut2Percent: string | null;
  clockAdjustment: string | null;
  otherAdjustment: string | null;
  programHours: ParsedCalculationProgramHours[];
  sourceResults: CalculationWorkbookSourceResults;
  account: string | null;
  notes: string | null;
  phone: string | null;
  issues: CalculationWorkbookIssue[];
  sourceRowHashSha256: string;
  sourceSnapshot: Record<string, unknown>;
}

export interface CalculationsWorkbookParseResult {
  sourceFileName: string;
  checksumSha256: string;
  sourceSheetName: string;
  sourceRange: string;
  layoutValid: boolean;
  sourceRateHints: Record<CalculationWorkbookProgramCode, string | null>;
  rows: ParsedCalculationWorkbookRow[];
  warnings: string[];
  summary: {
    sourceRows: number;
    reviewRows: number;
    distinctNormalizedPeople: number;
    distinctSourceKeys: number;
  };
}

interface CalculationLayout {
  headerRow: number;
  name: number;
  renewal: number;
  cut1: number;
  cut2: number;
  clock: number;
  adjustments: number;
  programs: Record<CalculationWorkbookProgramCode, number>;
  yearlyGross: number;
  monthlyGross: number;
  grossNet: number;
  net: number;
  afterAll: number;
  account: number;
  notes: number;
  phone: number;
}

function normalizedHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/%/g, " percent ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function headerColumn(row: ExcelJS.Row, label: string): number | null {
  const wanted = normalizedHeader(label);
  for (let column = 1; column <= Math.max(row.cellCount, 30); column += 1) {
    if (normalizedHeader(row.getCell(column).text) === wanted) return column;
  }
  return null;
}

function detectLayout(sheet: ExcelJS.Worksheet): CalculationLayout | null {
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 10); rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cut1 = headerColumn(row, "1st %");
    const cut2 = headerColumn(row, "2nd %");
    const clock = headerColumn(row, "Clock");
    const adjustments = headerColumn(row, "Adjustments");
    const yearlyGross = headerColumn(row, "Yearly Gross");
    const monthlyGross = headerColumn(row, "Monthly Gross");
    const grossNet = headerColumn(row, "Gross Net");
    const net = headerColumn(row, "Net");
    const afterAll = headerColumn(row, "After All");
    const programEntries = CALCULATION_WORKBOOK_PROGRAM_HEADERS.map((program) => [
      program.programCode,
      headerColumn(row, program.header),
    ] as const);
    if (
      !cut1 || !cut2 || !clock || !adjustments || !yearlyGross || !monthlyGross
      || !grossNet || !net || !afterAll || programEntries.some(([, column]) => !column)
    ) {
      continue;
    }

    const programs = Object.fromEntries(programEntries) as Record<
      CalculationWorkbookProgramCode,
      number
    >;
    return {
      headerRow: rowNumber,
      // The reviewed workbook leaves the name and renewal headers blank. Their
      // positions are stable relative to the named cut columns.
      name: cut1 - 2,
      renewal: cut1 - 1,
      cut1,
      cut2,
      clock,
      adjustments,
      programs,
      yearlyGross,
      monthlyGross,
      grossNet,
      net,
      afterAll,
      account: afterAll + 1,
      notes: afterAll + 2,
      phone: afterAll + 3,
    };
  }
  return null;
}

function layoutWarnings(layout: CalculationLayout): string[] {
  const expected = [
    layout.name,
    layout.renewal,
    layout.cut1,
    layout.cut2,
    layout.clock,
    layout.adjustments,
    ...CALCULATION_WORKBOOK_PROGRAM_HEADERS.map((p) => layout.programs[p.programCode]),
  ];
  for (let index = 1; index < expected.length; index += 1) {
    if (expected[index] !== expected[index - 1]! + 1) {
      return [
        "The Calculations columns do not match the reviewed contiguous layout; apply mode is disabled.",
      ];
    }
  }
  if (
    layout.monthlyGross !== layout.yearlyGross + 1
    || layout.grossNet !== layout.monthlyGross + 1
    || layout.net !== layout.grossNet + 1
    || layout.afterAll !== layout.net + 1
  ) {
    return [
      "The Calculations result columns do not match the reviewed layout; apply mode is disabled.",
    ];
  }
  return [];
}

function formulaResult(cell: ExcelJS.Cell): unknown {
  if (cell.formula) return cell.result ?? null;
  return cell.value;
}

function jsonScalar(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "");
  }
  return String(value);
}

function sourceCell(cell: ExcelJS.Cell): CalculationWorkbookSourceCell {
  return {
    address: cell.address,
    text: cell.text.trim(),
    value: cell.formula ? null : jsonScalar(cell.value),
    formula: cell.formula ? String(cell.formula) : null,
    result: cell.formula ? jsonScalar(cell.result) : null,
  };
}

function sourceText(cell: ExcelJS.Cell): string {
  const value = formulaResult(cell);
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return cell.text.trim();
}

function excelSerialFromDate(value: Date, date1904: boolean): string {
  return dec(value.getTime())
    .dividedBy(86_400_000)
    .plus(25_569)
    .minus(date1904 ? 1_462 : 0)
    .toDecimalPlaces(10)
    .toString();
}

function numericCellValue(cell: ExcelJS.Cell, date1904: boolean): string | null {
  const value = formulaResult(cell);
  if (value instanceof Date) return excelSerialFromDate(value, date1904);
  if (typeof value === "number" || typeof value === "string") {
    const parsed = tryDec(value);
    return parsed ? parsed.toString() : null;
  }
  return null;
}

function columnLetter(column: number): string {
  let value = column;
  let output = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

function parseIsoDate(cell: ExcelJS.Cell): string | null {
  const value = formulaResult(cell);
  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    if (year < 2000 || year > 2200) return null;
    return value.toISOString().slice(0, 10);
  }
  const text = sourceText(cell);
  if (text === "") return null;
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const year = match ? Number(match[1]) : null;
  const month = match ? Number(match[2]) : null;
  const day = match ? Number(match[3]) : null;
  if (!match) {
    match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  }
  if (!match) return null;
  const candidateYear = year ?? Number(match[3]);
  const candidateMonth = month ?? Number(match[1]);
  const candidateDay = day ?? Number(match[2]);
  const candidate = new Date(Date.UTC(candidateYear, candidateMonth - 1, candidateDay));
  if (
    candidateYear < 2000
    || candidateYear > 2200
    || candidate.getUTCFullYear() !== candidateYear
    || candidate.getUTCMonth() + 1 !== candidateMonth
    || candidate.getUTCDate() !== candidateDay
  ) {
    return null;
  }
  return candidate.toISOString().slice(0, 10);
}

function parseFraction(
  cell: ExcelJS.Cell,
  date1904: boolean,
  issues: CalculationWorkbookIssue[],
  field: "first" | "second",
): string | null {
  const text = sourceText(cell);
  if (text === "") return "0.000000";
  const numeric = numericCellValue(cell, date1904);
  const parsed = numeric === null ? null : tryDec(numeric);
  if (!parsed || parsed.isNegative() || parsed.greaterThan(100)) {
    issues.push({
      code: `invalid_${field}_cut`,
      message: `The ${field} cut must be a number from 0 through 100.`,
      cell: cell.address,
    });
    return null;
  }
  return parsed.dividedBy(100).toFixed(6);
}

function parseMoneyCell(
  cell: ExcelJS.Cell,
  date1904: boolean,
  issues: CalculationWorkbookIssue[],
  code: string,
  message: string,
  options: { required?: boolean } = {},
): string | null {
  const text = sourceText(cell);
  if (text === "") {
    if (options.required) issues.push({ code, message, cell: cell.address });
    return options.required ? null : "0.0000";
  }
  const numeric = numericCellValue(cell, date1904);
  const parsed = numeric === null ? null : tryDec(numeric);
  if (!parsed || parsed.decimalPlaces() > 4 || parsed.abs().greaterThan("9999999999.9999")) {
    issues.push({ code, message, cell: cell.address });
    return null;
  }
  return toMoney(parsed);
}

function parseHoursCell(
  cell: ExcelJS.Cell,
  date1904: boolean,
  issues: CalculationWorkbookIssue[],
): string | null {
  if (sourceText(cell) === "") return null;
  const numeric = numericCellValue(cell, date1904);
  const parsed = numeric === null ? null : tryDec(numeric);
  if (!parsed || parsed.isNegative() || parsed.decimalPlaces() > 4 || parsed.greaterThan("999999.9999")) {
    issues.push({
      code: "invalid_authorized_hours",
      message: "Program hours must be a non-negative number within the database precision.",
      cell: cell.address,
    });
    return null;
  }
  return toHours(parsed);
}

function parseCalculatedCell(
  cell: ExcelJS.Cell,
  date1904: boolean,
  issues: CalculationWorkbookIssue[],
  code: string,
  message: string,
): string | null {
  const numeric = numericCellValue(cell, date1904);
  const parsed = numeric === null ? null : tryDec(numeric);
  // Formula caches commonly retain more than four decimal places. They are
  // comparison evidence, not values written into numeric(14,4) columns.
  if (!parsed || parsed.abs().greaterThan("9999999999.9999999999")) {
    issues.push({ code, message, cell: cell.address });
    return null;
  }
  return parsed.toString();
}

function formulaReferences(cell: ExcelJS.Cell): Set<string> {
  const references = new Set<string>();
  for (const match of (cell.formula ?? "").toUpperCase().matchAll(/\$?([A-Z]{1,3})\$?(\d+)/g)) {
    references.add(`${match[1]}${match[2]}`);
  }
  return references;
}

function formulaDivisor(cell: ExcelJS.Cell): string | null {
  const formula = cell.formula ?? "";
  const match = formula.match(/\/\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = tryDec(match[1]);
  if (!parsed || !parsed.greaterThan(0) || parsed.greaterThan("999.999")) return null;
  return parsed.toFixed(3);
}

function splitStrategyName(sourceLabel: string): {
  matchLabel: string;
  strategyLabel: string;
} {
  const withoutAnnotation = sourceLabel.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const suffix = withoutAnnotation.match(/^(.*?)\s+([12])$/);
  if (!suffix) return { matchLabel: withoutAnnotation, strategyLabel: "1" };
  return { matchLabel: suffix[1]!.trim(), strategyLabel: suffix[2]! };
}

function rowSnapshot(row: ExcelJS.Row, maxColumn: number): Record<string, unknown> {
  const cells: Record<string, CalculationWorkbookSourceCell> = {};
  for (let column = 1; column <= maxColumn; column += 1) {
    const cell = row.getCell(column);
    if (cell.value !== null) cells[cell.address] = sourceCell(cell);
  }
  return { cells };
}

/** Read the source workbook without changing it or trusting its rate row. */
export async function parseCalculationsWorkbook(
  bytes: Buffer,
  sourceFileName: string,
): Promise<CalculationsWorkbookParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const candidates = workbook.worksheets
    .map((sheet) => ({ sheet, layout: detectLayout(sheet) }))
    .filter((candidate): candidate is { sheet: ExcelJS.Worksheet; layout: CalculationLayout } =>
      candidate.layout !== null,
    );
  if (candidates.length === 0) {
    throw new Error(
      "No sheet contains the reviewed Calculations headers (cuts, programs, and result columns).",
    );
  }
  const selected = candidates.find((candidate) =>
    candidate.sheet.name.trim().toLowerCase() === "calculations",
  ) ?? candidates.find((candidate) =>
    candidate.sheet.name.trim().toLowerCase() === "ahivim",
  ) ?? candidates[0]!;
  const { sheet, layout } = selected;
  const warnings = layoutWarnings(layout);
  if (candidates.length > 1) {
    warnings.push(
      `More than one sheet matched the Calculations layout; only "${sheet.name}" was parsed.`,
    );
  }

  const date1904 = workbook.properties.date1904 === true;
  const rateRow = layout.headerRow + 1;
  const sourceRateHints = Object.fromEntries(
    CALCULATION_WORKBOOK_PROGRAM_HEADERS.map((program) => {
      const value = numericCellValue(sheet.getRow(rateRow).getCell(layout.programs[program.programCode]), date1904);
      return [program.programCode, value];
    }),
  ) as Record<CalculationWorkbookProgramCode, string | null>;

  const rows: ParsedCalculationWorkbookRow[] = [];
  const maxColumn = Math.max(sheet.columnCount, layout.phone);
  for (let rowNumber = layout.headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const sourceIndividualLabel = sourceText(row.getCell(layout.name));
    if (!sourceIndividualLabel || normalizedHeader(sourceIndividualLabel) === "rates") continue;

    const issues: CalculationWorkbookIssue[] = [];
    const { matchLabel, strategyLabel } = splitStrategyName(sourceIndividualLabel);
    const normalizedIndividualLabel = normalizePersonName(matchLabel);
    if (!normalizedIndividualLabel) {
      issues.push({
        code: "missing_individual",
        message: "The source individual label is blank after removing strategy annotations.",
        cell: row.getCell(layout.name).address,
      });
    }

    const cutFormulaRefs = formulaReferences(row.getCell(layout.grossNet));
    const normalCut1 = row.getCell(layout.cut1).address;
    const normalCut2 = row.getCell(layout.cut2).address;
    const shiftedCut1 = row.getCell(layout.renewal).address;
    const shiftedCut2 = row.getCell(layout.cut1).address;
    const structurallyShifted = cutFormulaRefs.has(shiftedCut1)
      && cutFormulaRefs.has(shiftedCut2)
      && !cutFormulaRefs.has(normalCut2);

    let renewalDate = parseIsoDate(row.getCell(layout.renewal));
    let cut1Cell = row.getCell(layout.cut1);
    let cut2Cell = row.getCell(layout.cut2);
    let clockCell = row.getCell(layout.clock);
    let adjustmentsCell = row.getCell(layout.adjustments);
    if (structurallyShifted) {
      issues.push({
        code: "structurally_shifted_row",
        message: "The cut and adjustment cells are shifted left. The recovered values are retained for review but cannot be applied automatically.",
        cell: row.getCell(layout.renewal).address,
      });
      renewalDate = null;
      cut1Cell = row.getCell(layout.renewal);
      cut2Cell = row.getCell(layout.cut1);
      clockCell = row.getCell(layout.cut2);
      adjustmentsCell = row.getCell(layout.clock);
    } else if (sourceText(row.getCell(layout.renewal)) !== "" && renewalDate === null) {
      issues.push({
        code: "invalid_renewal_date",
        message: "Renewal is not a valid modern calendar date.",
        cell: row.getCell(layout.renewal).address,
      });
    }

    const noCalculationFormulas = [
      layout.yearlyGross,
      layout.monthlyGross,
      layout.grossNet,
      layout.net,
    ].every((column) => !row.getCell(column).formula);
    const placeholder = sourceText(cut1Cell).toUpperCase() === "X"
      && sourceText(cut2Cell).toUpperCase() === "X"
      && noCalculationFormulas;
    if (placeholder) {
      issues.push({
        code: "placeholder_row",
        message: "This X/X row has no calculation formulas and is preserved for review only.",
        cell: row.getCell(layout.name).address,
      });
    }

    const cut1Percent = parseFraction(cut1Cell, date1904, issues, "first");
    const cut2Percent = parseFraction(cut2Cell, date1904, issues, "second");
    const clockAdjustment = parseMoneyCell(
      clockCell,
      date1904,
      issues,
      "invalid_clock_adjustment",
      "Clock must be a signed amount within the database precision.",
    );
    const otherAdjustment = parseMoneyCell(
      adjustmentsCell,
      date1904,
      issues,
      "invalid_other_adjustment",
      "Adjustments must be a signed amount within the database precision.",
    );

    const monthlyCell = row.getCell(layout.monthlyGross);
    const monthDivisor = formulaDivisor(monthlyCell);
    if (!monthDivisor) {
      issues.push({
        code: "missing_month_divisor_formula",
        message: "Monthly Gross must contain an auditable positive divisor formula.",
        cell: monthlyCell.address,
      });
    }

    const programHours = CALCULATION_WORKBOOK_PROGRAM_HEADERS.map((program) => {
      const cell = row.getCell(layout.programs[program.programCode]);
      return {
        programCode: program.programCode,
        sourceCell: cell.address,
        authorizedHours: parseHoursCell(cell, date1904, issues),
        sourceFormula: cell.formula ? String(cell.formula) : null,
      };
    });
    if (!programHours.some((line) => line.authorizedHours && !dec(line.authorizedHours).isZero())) {
      issues.push({
        code: "missing_program_hours",
        message: "At least one program must have positive authorized hours.",
        cell: row.getCell(layout.name).address,
      });
    }

    const resultCells = {
      yearlyGross: row.getCell(layout.yearlyGross),
      monthlyGross: row.getCell(layout.monthlyGross),
      grossNet: row.getCell(layout.grossNet),
      net: row.getCell(layout.net),
    };
    for (const [field, cell] of Object.entries(resultCells)) {
      if (!cell.formula) {
        issues.push({
          code: `missing_${field}_formula`,
          message: `${field} must retain a source formula and cached result.`,
          cell: cell.address,
        });
      }
    }
    const afterAllCell = row.getCell(layout.afterAll);
    if (afterAllCell.formula) {
      issues.push({
        code: "after_all_must_be_approved_value",
        message: "After All must be a directly approved value, not a spreadsheet formula.",
        cell: afterAllCell.address,
      });
    }
    const sourceResults: CalculationWorkbookSourceResults = {
      yearlyGross: parseCalculatedCell(resultCells.yearlyGross, date1904, issues, "invalid_yearly_gross", "Yearly Gross needs a numeric cached result."),
      monthlyGross: parseCalculatedCell(resultCells.monthlyGross, date1904, issues, "invalid_monthly_gross", "Monthly Gross needs a numeric cached result."),
      grossNet: parseCalculatedCell(resultCells.grossNet, date1904, issues, "invalid_gross_net", "Gross Net needs a numeric cached result."),
      net: parseCalculatedCell(resultCells.net, date1904, issues, "invalid_net", "Net needs a numeric cached result."),
      afterAll: parseMoneyCell(afterAllCell, date1904, issues, "invalid_after_all", "After All needs a directly approved numeric value.", { required: true }),
    };

    if (
      !structurallyShifted
      && row.getCell(layout.grossNet).formula
      && (!cutFormulaRefs.has(normalCut1) || !cutFormulaRefs.has(normalCut2))
    ) {
      issues.push({
        code: "unexpected_cut_formula",
        message: "Gross Net does not visibly apply both configured cuts in sequence.",
        cell: row.getCell(layout.grossNet).address,
      });
    }

    const accountText = sourceText(row.getCell(layout.account));
    const notesText = sourceText(row.getCell(layout.notes));
    const phoneText = sourceText(row.getCell(layout.phone));
    const phoneDigits = phoneText.replace(/\D/g, "");
    if (phoneText && (phoneDigits.length < 7 || phoneDigits.length > 15)) {
      issues.push({
        code: "invalid_phone",
        message: "The source phone is not a plausible 7-to-15 digit contact number.",
        cell: row.getCell(layout.phone).address,
      });
    }
    const snapshot = {
      ...rowSnapshot(row, maxColumn),
      recovered: {
        structurallyShifted,
        renewalDate,
        monthDivisor,
        cut1Percent,
        cut2Percent,
        clockAdjustment,
        otherAdjustment,
      },
    };
    const sourceRowHashSha256 = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    rows.push({
      sourceRowNumber: rowNumber,
      sourceIndividualLabel,
      individualMatchLabel: matchLabel,
      normalizedIndividualLabel,
      strategyLabel,
      sourceKey: `${normalizedIndividualLabel}|${strategyLabel}`,
      renewalDate,
      monthDivisor,
      cut1Percent,
      cut2Percent,
      clockAdjustment,
      otherAdjustment,
      programHours,
      sourceResults,
      account: accountText || null,
      notes: notesText || null,
      phone: phoneText || null,
      issues,
      sourceRowHashSha256,
      sourceSnapshot: snapshot,
    });
  }

  const firstRow = rows[0]?.sourceRowNumber ?? layout.headerRow + 1;
  const lastRow = rows.at(-1)?.sourceRowNumber ?? firstRow;
  return {
    sourceFileName: sourceFileName.trim() || "Calculations workbook",
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceSheetName: sheet.name,
    sourceRange: `${sheet.name}!A${firstRow}:${columnLetter(maxColumn)}${lastRow}`,
    layoutValid: warnings.length === 0,
    sourceRateHints,
    rows,
    warnings,
    summary: {
      sourceRows: rows.length,
      reviewRows: rows.filter((row) => row.issues.length > 0).length,
      distinctNormalizedPeople: new Set(
        rows.map((row) => row.normalizedIndividualLabel).filter(Boolean),
      ).size,
      distinctSourceKeys: new Set(rows.map((row) => row.sourceKey)).size,
    },
  };
}
