import { createHash } from "node:crypto";
import { closeEnough, dec, tryDec } from "@/lib/money";
import {
  AHIVIM_POSITIONAL,
  AHIVIM_HEADER_ALIASES,
  REQUIRED_AHIVIM_FIELDS,
  CONTROL_TOTAL_CELLS,
  normalizeHeader,
  ahivimRowSchema,
  type AhivimField,
} from "@/lib/excel/column-map";
import type { ParsedAhivimRow, WorkbookControlTotals } from "@/lib/excel/parse-workbook";

/**
 * GOOGLE SHEET CSV PARSING
 * ========================
 *
 * The authenticated Values API grid or pinned authoritative CSV export is mapped
 * into exactly the same `ParsedAhivimRow` shape the .xlsx importer produces, so the
 * entire downstream pipeline — staging, matching, rate logic, group detection,
 * fingerprint de-duplication, reconciliation, commit and audit — is reused
 * verbatim. Nothing about the sync path re-implements business logic.
 *
 * The parser is deliberately DEFENSIVE about structure. The source may or may
 * not treat the sheet's first line as a header, so the header row and the
 * control-total row are located by CONTENT (known column labels; the four total
 * cells) rather than by a fixed line number. Whatever the export decides, the
 * transaction columns are mapped by the verified positional map, falling back
 * from header matching exactly as the workbook parser does.
 *
 * Both read transports return calculated values rather than formulas, so
 * `formulas` is always empty. That is expected in the reuse contract; the calculated
 * internal amount arrives as a plain number in column P.
 */

export interface SheetCsvParseResult {
  /** The raw parsed grid, for diagnostics. */
  grid: string[][];
  headerRowIndex: number | null;
  columnMap: Record<AhivimField, number>;
  mappingStrategy: "header" | "positional";
  ahivimRows: ParsedAhivimRow[];
  /** Numeric row-1 controls accepted for reconciliation. */
  controlTotals: WorkbookControlTotals;
  /** Exact trimmed values displayed in the source Sheet's row-1 control cells. */
  rawControlTotals: WorkbookControlTotals;
  /**
   * P1/Q1 only when the corresponding source column proves that the displayed
   * control covers every parsed row. Google CSV exports keep a SUBTOTAL's
   * displayed value but discard the filter/formula metadata that defines its
   * scope, so an unproved value must not be compared with a whole-Sheet import.
   */
  wholeSheetControlTotals: Pick<WorkbookControlTotals, "internalAmount" | "agencyGross">;
  controlTotalEvidence: {
    internalAmount: SheetControlTotalEvidence;
    agencyGross: SheetControlTotalEvidence;
  };
  /**
   * A stable content hash of the transaction rows. Identical sheet content
   * yields an identical hash regardless of CSV formatting jitter, so an
   * unchanged sheet is recognised without re-importing anything.
   */
  snapshotSha256: string;
  totalDataRows: number;
  warnings: string[];
  /** True when a Paid column was found by header or exists at the verified
   *  positional column — then its values are the source of truth. */
  paidColumnFound: boolean;
}

export type SheetControlTotalStatus =
  | "whole_source"
  | "scoped_or_mismatched"
  | "invalid_control"
  | "unverified"
  | "missing";

export interface SheetControlTotalEvidence {
  status: SheetControlTotalStatus;
  /** Parsed numeric control, when the displayed value is usable. */
  supplied: string | null;
  /** Exact trimmed displayed value, including spreadsheet errors such as #REF!. */
  rawSupplied: string | null;
  /** Decimal-safe total of every nonblank numeric source value, when provable. */
  allRowsTotal: string | null;
}

/**
 * A minimal RFC 4180 CSV reader. Handles quoted fields, escaped quotes (""),
 * embedded commas and newlines, and both \n and \r\n line endings. No external
 * dependency is pulled in for what is a small, well-understood grammar.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      sawAnyChar = true;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      sawAnyChar = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      sawAnyChar = true;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyChar = false;
    } else if (c === "\r") {
      // Ignore; a following \n closes the record.
    } else {
      field += c;
      sawAnyChar = true;
    }
  }

  // A truncated quoted record can swallow otherwise valid subsequent rows.
  // Reject the snapshot before any sync reconciliation can mistake those rows
  // for missing source records or commit a partially decoded transaction.
  if (inQuotes) {
    throw new Error("The Google Sheet CSV contains an unterminated quoted field. Nothing was imported; retry after the source export is complete.");
  }

  // Flush a final record that was not newline-terminated.
  if (sawAnyChar || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cell(grid: string[][], rowIndex: number, col1Indexed: number): string {
  const r = grid[rowIndex];
  if (!r) return "";
  return (r[col1Indexed - 1] ?? "").trim();
}

function findHeaderRow(grid: string[][]): { index: number; headers: string[] } | null {
  const limit = Math.min(grid.length, 12);
  for (let n = 0; n < limit; n++) {
    const headers = (grid[n] ?? []).map((v) => normalizeHeader(v));
    const nonEmpty = headers.filter(Boolean).length;
    const known = headers.filter((h) =>
      Object.values(AHIVIM_HEADER_ALIASES).some((aliases) => aliases.includes(h)),
    ).length;
    if (nonEmpty >= 5 && known >= 4) return { index: n, headers };
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

/** Coerce common spreadsheet date spellings to ISO, leaving anything else alone. */
function normalizeDates(raw: Record<AhivimField, string>): Partial<Record<AhivimField, string>> {
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
    // Anything else is left as-is; validation reports it rather than guessing.
  }
  return out;
}

function isBlankRow(values: Record<AhivimField, string>): boolean {
  return Object.values(values).every((v) => v.trim() === "");
}

const NUMERIC_FIELDS = new Set<AhivimField>([
  "hours",
  "rate",
  "amount",
  "totalNetPay",
  "calculatedInternalAmount",
]);

/**
 * Google Sheets can display a negative value in accounting format as
 * `$ (625.00)` (or `(625.00)`). Historical CSV/workbook inputs can contain that
 * display text, while the shared row schema accepts only a canonical numeric
 * string. Normalize only the value passed to validation; `raw` keeps the exact
 * source text for the import audit trail.
 */
export function normalizeAccountingNumber(value: string): string {
  const trimmed = value.trim();
  const accounting = trimmed.match(/^\$?\s*\(\s*\$?\s*([\d,]+(?:\.\d+)?)\s*\)$/);
  if (!accounting) return trimmed;
  return `-${accounting[1]!.replace(/,/g, "")}`;
}

/** Locate the control-total row (the row above the header carrying the four totals). */
function emptyControlTotals(): WorkbookControlTotals {
  return {
    internalAmount: null,
    agencyGross: null,
    agencyRetention: null,
    deduplicatedNetPay: null,
  };
}

function readControlTotals(
  grid: string[][],
  headerRowIndex: number | null,
): { controlTotals: WorkbookControlTotals; rawControlTotals: WorkbookControlTotals } {
  const upTo = headerRowIndex ?? 2;
  const numberish = (value: string): string | null => {
    const normalized = normalizeAccountingNumber(value);
    return normalized !== "" && /^-?\$?[\d,]*\.?\d+$/.test(normalized.replace(/\s/g, ""))
      ? normalized
      : null;
  };

  let firstNonblank: WorkbookControlTotals | null = null;
  // Prefer a row with at least one valid numeric control. If every displayed
  // control is an error (for example #REF!), retain the first nonblank P:S row
  // so a broken Sheet control remains visible in the audit instead of silently
  // becoming indistinguishable from a missing control.
  for (let n = 0; n < upTo; n++) {
    const raw: WorkbookControlTotals = {
      internalAmount: cell(grid, n, CONTROL_TOTAL_CELLS.internalAmount.col) || null,
      agencyGross: cell(grid, n, CONTROL_TOTAL_CELLS.agencyGross.col) || null,
      agencyRetention: cell(grid, n, CONTROL_TOTAL_CELLS.agencyRetention.col) || null,
      deduplicatedNetPay: cell(grid, n, CONTROL_TOTAL_CELLS.deduplicatedNetPay.col) || null,
    };
    const rawValues = Object.values(raw);
    if (!rawValues.some((value) => value !== null)) continue;
    firstNonblank ??= raw;

    const parsed: WorkbookControlTotals = {
      internalAmount: raw.internalAmount === null ? null : numberish(raw.internalAmount),
      agencyGross: raw.agencyGross === null ? null : numberish(raw.agencyGross),
      agencyRetention: raw.agencyRetention === null ? null : numberish(raw.agencyRetention),
      deduplicatedNetPay:
        raw.deduplicatedNetPay === null ? null : numberish(raw.deduplicatedNetPay),
    };
    if (Object.values(parsed).some((value) => value !== null)) {
      return { controlTotals: parsed, rawControlTotals: raw };
    }
  }

  const rawControlTotals = firstNonblank ?? emptyControlTotals();
  return {
    rawControlTotals,
    controlTotals: {
      internalAmount:
        rawControlTotals.internalAmount === null
          ? null
          : numberish(rawControlTotals.internalAmount),
      agencyGross:
        rawControlTotals.agencyGross === null ? null : numberish(rawControlTotals.agencyGross),
      agencyRetention:
        rawControlTotals.agencyRetention === null
          ? null
          : numberish(rawControlTotals.agencyRetention),
      deduplicatedNetPay:
        rawControlTotals.deduplicatedNetPay === null
          ? null
          : numberish(rawControlTotals.deduplicatedNetPay),
    },
  };
}

const CONTROL_TOTAL_TOLERANCE = "0.05";

function proveWholeSheetControl(
  rows: readonly ParsedAhivimRow[],
  field: "amount" | "calculatedInternalAmount",
  rawSupplied: string | null,
  supplied: string | null,
): SheetControlTotalEvidence {
  if (rawSupplied === null) {
    return { status: "missing", supplied: null, rawSupplied: null, allRowsTotal: null };
  }

  let allRowsTotal = dec(0);
  let sourceColumnIsNumeric = true;
  for (const row of rows) {
    const raw = normalizeAccountingNumber(row.raw[field]);
    // SUBTOTAL ignores blanks. A nonblank value that is not numeric makes the
    // source-column total unknowable; never infer scope from the remaining rows.
    if (raw === "") continue;
    const value = tryDec(raw);
    if (value === null) {
      sourceColumnIsNumeric = false;
      break;
    }
    allRowsTotal = allRowsTotal.plus(value);
  }

  const total = sourceColumnIsNumeric ? allRowsTotal.toString() : null;
  if (supplied === null) {
    return {
      status: "invalid_control",
      supplied: null,
      rawSupplied,
      allRowsTotal: total,
    };
  }
  if (!sourceColumnIsNumeric) {
    return { status: "unverified", supplied, rawSupplied, allRowsTotal: null };
  }
  return {
    status: closeEnough(allRowsTotal, supplied, CONTROL_TOTAL_TOLERANCE)
      ? "whole_source"
      : "scoped_or_mismatched",
    supplied,
    rawSupplied,
    allRowsTotal: total,
  };
}

function safeDisplayedControl(value: string): string {
  const compact = value.replace(/\s+/g, " ").slice(0, 80);
  return JSON.stringify(compact);
}

function controlScopeWarning(
  evidence: SheetControlTotalEvidence,
  cellRef: "P1" | "Q1",
  sourceColumn: "P" | "G",
): string | null {
  if (evidence.status === "scoped_or_mismatched") {
    return (
      `The Sheet's ${cellRef} control is ${evidence.supplied}, but all parsed source rows in ` +
      `column ${sourceColumn} total ${evidence.allRowsTotal}. The control may be filtered or ` +
      "otherwise partial, so it was preserved for audit but not used as a whole-Sheet " +
      "reconciliation control."
    );
  }
  if (evidence.status === "unverified") {
    return (
      `The Sheet's ${cellRef} control was preserved for audit but not used as a whole-Sheet ` +
      `reconciliation control because column ${sourceColumn} contains a nonblank, nonnumeric ` +
      "source value."
    );
  }
  if (evidence.status === "invalid_control") {
    return (
      `The Sheet's ${cellRef} control contains the nonnumeric or error value ` +
      `${safeDisplayedControl(evidence.rawSupplied ?? "")}. It was preserved for audit but not ` +
      "used as a whole-Sheet reconciliation control."
    );
  }
  return null;
}

/**
 * Parse a Google-Sheet CSV export of the Ahivim tab into the shared row shape.
 */
export function parseSheetCsv(csvText: string): SheetCsvParseResult {
  const warnings: string[] = [];
  const gridRows = parseCsv(csvText)
    .map((cells, index) => ({ cells, sourceRowNumber: index + 1 }))
    .filter((row) => row.cells.some((cellValue) => cellValue.trim() !== ""));
  const grid = gridRows.map((row) => row.cells);

  const header = findHeaderRow(grid);
  let columnMap = { ...AHIVIM_POSITIONAL };
  let mappingStrategy: "header" | "positional" = "positional";
  let paidHeaderFound = false;
  if (header) {
    const built = buildColumnMap(header.headers);
    columnMap = built.map;
    mappingStrategy = built.strategy;
    paidHeaderFound = !built.unresolved.includes("paid");
    if (built.unresolved.length) {
      warnings.push(
        `These columns were not found by header and fell back to their known position: ${built.unresolved.join(", ")}.`,
      );
    }
  } else {
    warnings.push(
      "No header row was identified in the sheet export; falling back to fixed column positions.",
    );
  }

  const { controlTotals, rawControlTotals } = readControlTotals(grid, header?.index ?? null);

  const firstDataRow = (header?.index ?? 1) + 1;
  const ahivimRows: ParsedAhivimRow[] = [];
  const signatures: string[] = [];

  for (let n = firstDataRow; n < grid.length; n++) {
    const raw = {} as Record<AhivimField, string>;
    for (const field of Object.keys(columnMap) as AhivimField[]) {
      raw[field] = cell(grid, n, columnMap[field]);
    }
    if (isBlankRow(raw)) continue;

    const normalized = { ...raw, ...normalizeDates(raw) };
    for (const field of NUMERIC_FIELDS) {
      normalized[field] = normalizeAccountingNumber(raw[field]);
    }
    const result = ahivimRowSchema.safeParse(normalized);

    // Source row number is 1-indexed to mirror the workbook's row numbering.
    const sourceRowNumber = gridRows[n]!.sourceRowNumber;
    ahivimRows.push({
      sourceRowNumber,
      raw,
      formulas: {},
      parsed: result.success ? result.data : null,
      errors: result.success
        ? []
        : result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
    });

    // Content signature: the parsed canonical values when valid, else the raw
    // cells. Independent of any database matching, so the snapshot hash is a
    // pure function of the sheet's content.
    const sig = result.success
      ? JSON.stringify(result.data)
      : JSON.stringify(raw);
    signatures.push(sig);
  }

  const controlTotalEvidence = {
    internalAmount: proveWholeSheetControl(
      ahivimRows,
      "calculatedInternalAmount",
      rawControlTotals.internalAmount,
      controlTotals.internalAmount,
    ),
    agencyGross: proveWholeSheetControl(
      ahivimRows,
      "amount",
      rawControlTotals.agencyGross,
      controlTotals.agencyGross,
    ),
  };
  const wholeSheetControlTotals = {
    internalAmount:
      controlTotalEvidence.internalAmount.status === "whole_source"
        ? controlTotals.internalAmount
        : null,
    agencyGross:
      controlTotalEvidence.agencyGross.status === "whole_source"
        ? controlTotals.agencyGross
        : null,
  };
  for (const warning of [
    controlScopeWarning(controlTotalEvidence.internalAmount, "P1", "P"),
    controlScopeWarning(controlTotalEvidence.agencyGross, "Q1", "G"),
  ]) {
    if (warning) warnings.push(warning);
  }

  // The workbook's Paid column is positional N and its header is intentionally
  // blank. Presence cannot depend on a non-empty cell: a cleared marker is still
  // preserved as false in inbound source evidence. It never changes the Neon
  // Paid decision. A physically shorter response can omit column N entirely.
  const paidColumnPositionPresent = gridRows.some((row) => row.cells.length >= columnMap.paid);
  const paidColumnFound = paidHeaderFound || paidColumnPositionPresent;

  // Sort so row re-ordering in the sheet does not read as a content change.
  signatures.sort();
  const snapshotSha256 = createHash("sha256")
    .update(signatures.join(""))
    .digest("hex");

  return {
    grid,
    headerRowIndex: header?.index ?? null,
    columnMap,
    mappingStrategy,
    ahivimRows,
    controlTotals,
    rawControlTotals,
    wholeSheetControlTotals,
    controlTotalEvidence,
    snapshotSha256,
    totalDataRows: ahivimRows.length,
    warnings,
    paidColumnFound,
  };
}

