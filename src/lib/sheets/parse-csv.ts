import { createHash } from "node:crypto";
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
 * The live Google Sheet is exported as CSV (the gviz endpoint) and mapped into
 * exactly the same `ParsedAhivimRow` shape the .xlsx importer produces, so the
 * entire downstream pipeline — staging, matching, rate logic, group detection,
 * fingerprint de-duplication, reconciliation, commit and audit — is reused
 * verbatim. Nothing about the sync path re-implements business logic.
 *
 * The parser is deliberately DEFENSIVE about structure. The gviz export may or
 * may not treat the sheet's first line as a header, so the header row and the
 * control-total row are located by CONTENT (known column labels; the four total
 * cells) rather than by a fixed line number. Whatever the export decides, the
 * transaction columns are mapped by the verified positional map, falling back
 * from header matching exactly as the workbook parser does.
 *
 * Formulas do not survive a CSV export — every cell is its displayed value — so
 * `formulas` is always empty. That is expected and documented in the reuse
 * contract; the calculated internal amount arrives as a plain number in column P.
 */

export interface SheetCsvParseResult {
  /** The raw parsed grid, for diagnostics. */
  grid: string[][];
  headerRowIndex: number | null;
  columnMap: Record<AhivimField, number>;
  mappingStrategy: "header" | "positional";
  ahivimRows: ParsedAhivimRow[];
  controlTotals: WorkbookControlTotals;
  /**
   * A stable content hash of the transaction rows. Identical sheet content
   * yields an identical hash regardless of CSV formatting jitter, so an
   * unchanged sheet is recognised without re-importing anything.
   */
  snapshotSha256: string;
  totalDataRows: number;
  warnings: string[];
  /** True when a "Paid" column was found by header — then its values are the
   *  source of truth for each transaction's paid status on this sync. */
  paidColumnFound: boolean;
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

/** Locate the control-total row (the row above the header carrying the four totals). */
function readControlTotals(
  grid: string[][],
  headerRowIndex: number | null,
): WorkbookControlTotals {
  const totals: WorkbookControlTotals = {
    internalAmount: null,
    agencyGross: null,
    agencyRetention: null,
    deduplicatedNetPay: null,
  };
  const upTo = headerRowIndex ?? 2;
  const numberish = (v: string) => v !== "" && /-?\$?[\d,]*\.?\d+/.test(v);
  // Scan every row above the header for one that carries ANY of the four control
  // totals in its known column; take all four totals from that row.
  for (let n = 0; n < upTo; n++) {
    const internal = cell(grid, n, CONTROL_TOTAL_CELLS.internalAmount.col);
    const gross = cell(grid, n, CONTROL_TOTAL_CELLS.agencyGross.col);
    const retention = cell(grid, n, CONTROL_TOTAL_CELLS.agencyRetention.col);
    const net = cell(grid, n, CONTROL_TOTAL_CELLS.deduplicatedNetPay.col);
    if (numberish(internal) || numberish(gross) || numberish(retention) || numberish(net)) {
      totals.internalAmount = numberish(internal) ? internal : null;
      totals.agencyGross = numberish(gross) ? gross : null;
      totals.agencyRetention = numberish(retention) ? retention : null;
      totals.deduplicatedNetPay = numberish(net) ? net : null;
      break;
    }
  }
  return totals;
}

/**
 * Parse a Google-Sheet CSV export of the Ahivim tab into the shared row shape.
 */
export function parseSheetCsv(csvText: string): SheetCsvParseResult {
  const warnings: string[] = [];
  const grid = parseCsv(csvText).filter((r) => r.some((c) => c.trim() !== ""));

  const header = findHeaderRow(grid);
  let columnMap = { ...AHIVIM_POSITIONAL };
  let mappingStrategy: "header" | "positional" = "positional";
  let paidColumnFound = false;
  if (header) {
    const built = buildColumnMap(header.headers);
    columnMap = built.map;
    mappingStrategy = built.strategy;
    paidColumnFound = !built.unresolved.includes("paid");
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

  const controlTotals = readControlTotals(grid, header?.index ?? null);

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
    const result = ahivimRowSchema.safeParse(normalized);

    // Source row number is 1-indexed to mirror the workbook's row numbering.
    const sourceRowNumber = n + 1;
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
    snapshotSha256,
    totalDataRows: ahivimRows.length,
    warnings,
    paidColumnFound,
  };
}

