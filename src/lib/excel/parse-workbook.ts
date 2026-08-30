import ExcelJS from "exceljs";
import {
  AHIVIM_SHEET,
  CALCULATIONS_SHEET,
  AHIVIM_POSITIONAL,
  AHIVIM_HEADER_ALIASES,
  REQUIRED_AHIVIM_FIELDS,
  CONTROL_TOTAL_CELLS,
  normalizeHeader,
  ahivimRowSchema,
  type AhivimField,
  type AhivimRow,
} from "./column-map";

/**
 * WORKBOOK PARSING
 * ================
 *
 * Rules that matter here:
 *
 *  - Formulas are treated as SOURCE TEXT, never as application logic. We read
 *    the cached result where one exists and keep the formula string for audit.
 *    This workbook was exported from Google Sheets, so column P arrives as
 *    IFERROR(__xludf.DUMMYFUNCTION("COMPUTE...")) with a cached value; the
 *    wrapper is recorded and the cached number is used, never re-evaluated.
 *  - Shared formulas are resolved to their cached results, which matters on the
 *    Calculations sheet where most rows inherit row 5's formula.
 *  - Every value is stringified at the boundary. Nothing becomes a JS float on
 *    its way to a money column.
 *  - Cells beginning with =, +, -, @ are neutralised before they are ever
 *    written back out, to prevent spreadsheet formula injection on export.
 */

export interface SheetSummary {
  name: string;
  rowCount: number;
  columnCount: number;
  headerRowNumber: number | null;
  headers: string[];
}

export interface ParsedCell {
  text: string;
  formula: string | null;
  isError: boolean;
}

export interface ParsedAhivimRow {
  sourceRowNumber: number;
  raw: Record<AhivimField, string>;
  formulas: Partial<Record<AhivimField, string>>;
  parsed: AhivimRow | null;
  errors: { field: string; message: string }[];
}

export interface WorkbookControlTotals {
  internalAmount: string | null;
  agencyGross: string | null;
  agencyRetention: string | null;
  deduplicatedNetPay: string | null;
}

export interface WorkbookParseResult {
  sheets: SheetSummary[];
  templateDetected: "ahivim_v1" | "unknown";
  mappingStrategy: "header" | "positional";
  columnMap: Record<AhivimField, number>;
  ahivimRows: ParsedAhivimRow[];
  controlTotals: WorkbookControlTotals;
  calculationsRaw: string[][];
  warnings: string[];
}

const FORMULA_INJECTION_PREFIX = /^[=+\-@\t\r]/;

/** Neutralise a value that will later be written into a spreadsheet export. */
export function sanitizeForExport(value: string): string {
  return FORMULA_INJECTION_PREFIX.test(value) ? `'${value}` : value;
}

function cellToParsed(cell: ExcelJS.Cell | undefined): ParsedCell {
  if (!cell || cell.value === null || cell.value === undefined) {
    return { text: "", formula: null, isError: false };
  }
  const v = cell.value;

  if (typeof v === "object") {
    if (v instanceof Date) {
      return { text: v.toISOString().slice(0, 10), formula: null, isError: false };
    }
    if ("error" in v) {
      // #NAME?, #REF! and friends. Recorded, never trusted.
      return { text: "", formula: null, isError: true };
    }
    if ("formula" in v || "sharedFormula" in v) {
      const formula =
        ("formula" in v && v.formula ? String(v.formula) : null) ??
        ("sharedFormula" in v && v.sharedFormula ? `shared->${String(v.sharedFormula)}` : null);
      const result = "result" in v ? v.result : undefined;
      if (result && typeof result === "object" && "error" in result) {
        return { text: "", formula, isError: true };
      }
      if (result instanceof Date) {
        return { text: result.toISOString().slice(0, 10), formula, isError: false };
      }
      return {
        text: result === null || result === undefined ? "" : String(result),
        formula,
        isError: false,
      };
    }
    if ("richText" in v && Array.isArray(v.richText)) {
      return {
        text: v.richText.map((r: { text: string }) => r.text).join(""),
        formula: null,
        isError: false,
      };
    }
    if ("text" in v) {
      return { text: String(v.text ?? ""), formula: null, isError: false };
    }
  }

  return { text: String(v).trim(), formula: null, isError: false };
}

function findHeaderRow(sheet: ExcelJS.Worksheet): { rowNumber: number; headers: string[] } | null {
  const limit = Math.min(sheet.rowCount, 10);
  for (let n = 1; n <= limit; n++) {
    const row = sheet.getRow(n);
    const headers: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) =>
      headers.push(normalizeHeader(cellToParsed(cell).text)),
    );
    const nonEmpty = headers.filter(Boolean).length;
    // A header row is one where several known labels appear together.
    const known = headers.filter((h) =>
      Object.values(AHIVIM_HEADER_ALIASES).some((aliases) => aliases.includes(h)),
    ).length;
    if (nonEmpty >= 5 && known >= 4) return { rowNumber: n, headers };
  }
  return null;
}

function buildColumnMap(headers: string[]): {
  map: Record<AhivimField, number>;
  strategy: "header" | "positional";
  unresolved: AhivimField[];
} {
  const map = { ...AHIVIM_POSITIONAL };
  const unresolved: AhivimField[] = [];
  let matched = 0;

  for (const field of Object.keys(AHIVIM_HEADER_ALIASES) as AhivimField[]) {
    const aliases = AHIVIM_HEADER_ALIASES[field];
    const index = headers.findIndex((h) => aliases.includes(h));
    if (index >= 0) {
      map[field] = index + 1;
      matched++;
    } else {
      unresolved.push(field);
    }
  }

  return {
    map,
    strategy: matched >= REQUIRED_AHIVIM_FIELDS.length ? "header" : "positional",
    unresolved,
  };
}

function isBlankRow(values: Record<AhivimField, string>): boolean {
  return Object.values(values).every((v) => v.trim() === "");
}

export async function parseWorkbook(bytes: Buffer): Promise<WorkbookParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  const warnings: string[] = [];
  const sheets: SheetSummary[] = [];

  const ahivim = workbook.worksheets.find(
    (s) => s.name.trim().toLowerCase() === AHIVIM_SHEET.toLowerCase(),
  );
  const calculations = workbook.worksheets.find(
    (s) => s.name.trim().toLowerCase() === CALCULATIONS_SHEET.toLowerCase(),
  );

  for (const sheet of workbook.worksheets) {
    const header = findHeaderRow(sheet);
    sheets.push({
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      headerRowNumber: header?.rowNumber ?? null,
      headers: header?.headers.filter(Boolean) ?? [],
    });
  }

  if (!ahivim) warnings.push(`Sheet "${AHIVIM_SHEET}" was not found in this workbook.`);
  if (!calculations) warnings.push(`Sheet "${CALCULATIONS_SHEET}" was not found in this workbook.`);

  const templateDetected: WorkbookParseResult["templateDetected"] =
    ahivim && calculations ? "ahivim_v1" : "unknown";

  let columnMap = { ...AHIVIM_POSITIONAL };
  let mappingStrategy: "header" | "positional" = "positional";
  const ahivimRows: ParsedAhivimRow[] = [];
  const controlTotals: WorkbookControlTotals = {
    internalAmount: null,
    agencyGross: null,
    agencyRetention: null,
    deduplicatedNetPay: null,
  };

  if (ahivim) {
    const header = findHeaderRow(ahivim);
    if (header) {
      const built = buildColumnMap(header.headers);
      columnMap = built.map;
      mappingStrategy = built.strategy;
      if (built.unresolved.length) {
        warnings.push(
          `These columns were not found by header and fell back to their known position: ${built.unresolved.join(", ")}.`,
        );
      }
    } else {
      warnings.push(
        "No header row could be identified on the Ahivim sheet. Falling back to fixed column " +
          "positions.",
      );
    }

    // Control totals live above the header, in row 1.
    for (const [key, cell] of Object.entries(CONTROL_TOTAL_CELLS)) {
      const value = cellToParsed(ahivim.getRow(cell.row).getCell(cell.col)).text;
      controlTotals[key as keyof WorkbookControlTotals] = value === "" ? null : value;
    }

    const firstDataRow = (header?.rowNumber ?? 2) + 1;
    for (let n = firstDataRow; n <= ahivim.rowCount; n++) {
      const row = ahivim.getRow(n);
      const raw = {} as Record<AhivimField, string>;
      const formulas: Partial<Record<AhivimField, string>> = {};

      for (const field of Object.keys(columnMap) as AhivimField[]) {
        const cell = cellToParsed(row.getCell(columnMap[field]));
        raw[field] = cell.text.trim();
        if (cell.formula) formulas[field] = cell.formula;
        if (cell.isError && raw[field] === "") {
          // A formula error leaves the value blank; validation will catch it.
          formulas[field] = formulas[field] ?? "#ERROR";
        }
      }

      if (isBlankRow(raw)) continue;

      const normalized = { ...raw, ...normalizeAhivimDates(raw) };
      const result = ahivimRowSchema.safeParse(normalized);

      ahivimRows.push({
        sourceRowNumber: n,
        raw,
        formulas,
        parsed: result.success ? result.data : null,
        errors: result.success
          ? []
          : result.error.issues.map((i) => ({
              field: i.path.join("."),
              message: i.message,
            })),
      });
    }
  }

  const calculationsRaw: string[][] = [];
  if (calculations) {
    for (let n = 1; n <= calculations.rowCount; n++) {
      const row = calculations.getRow(n);
      const values: string[] = [];
      for (let c = 1; c <= Math.max(calculations.columnCount, 21); c++) {
        values.push(cellToParsed(row.getCell(c)).text.trim());
      }
      if (values.some((v) => v !== "")) calculationsRaw.push(values);
    }
  }

  return {
    sheets,
    templateDetected,
    mappingStrategy,
    columnMap,
    ahivimRows,
    controlTotals,
    calculationsRaw,
    warnings,
  };
}

/** Coerce common spreadsheet date spellings to ISO, leaving anything else alone. */
/** Normalize the stored source cells again when a held row is applied later. */
export function normalizeAhivimDates(
  raw: Record<AhivimField, string>,
): Partial<Record<AhivimField, string>> {
  const out: Partial<Record<AhivimField, string>> = {};
  for (const field of ["checkDate", "periodBegin", "periodEnd"] as const) {
    const v = raw[field];
    if (!v) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      out[field] = v;
      continue;
    }
    const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (m) {
      const [, mm, dd, yy] = m;
      const year = yy.length === 2 ? `20${yy}` : yy;
      out[field] = `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
      continue;
    }
    const parsed = new Date(v);
    out[field] = Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
  }
  return out;
}
