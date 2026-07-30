import { dec, formatHours } from "@/lib/money";

/**
 * Decimal-safe tabular export used by the spreadsheet workspaces to export the
 * *currently filtered view* as CSV or Excel. Numbers are written as real
 * numbers with a cell format so the sheet stays sortable; money and hours go
 * through decimal.js, never a float. Mirrors the reports exporter so the two
 * stay visually consistent.
 */
export type ExportFieldType = "text" | "date" | "money" | "hours" | "int" | "percent";

export interface ExportColumn {
  key: string;
  header: string;
  type: ExportFieldType;
}

export type ExportCell = string | number | null;

export interface ExportTable {
  title?: string;
  columns: ExportColumn[];
  rows: Record<string, ExportCell>[];
  emptyMessage?: string;
}

const NUM_FMT: Partial<Record<ExportFieldType, string>> = {
  money: "#,##0.00",
  hours: "#,##0.####",
  int: "#,##0",
  percent: "0.0%",
};

const isNumeric = (t: ExportFieldType) => t === "money" || t === "hours" || t === "int" || t === "percent";

function xlsxValue(type: ExportFieldType, value: ExportCell): string | number | null {
  if (value === null || value === "") return type === "text" || type === "date" ? "" : null;
  if (type === "money" || type === "hours") return dec(value).toNumber();
  if (type === "percent") return dec(value).dividedBy(100).toNumber();
  if (type === "int") return Number(value);
  return String(value);
}

function sheetName(name: string, index: number): string {
  const cleaned = (name || `Sheet ${index + 1}`).replace(/[\\/?*[\]:]/g, " ").trim();
  return cleaned.slice(0, 28) || `Sheet ${index + 1}`;
}

export async function buildXlsx(title: string, tables: ExportTable[]): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ahivim Budget Management";
  wb.created = new Date();

  tables.forEach((table, i) => {
    const ws = wb.addWorksheet(sheetName(table.title ?? title, i));
    const header = ws.addRow(table.columns.map((c) => c.header));
    header.font = { bold: true };
    for (const row of table.rows) {
      ws.addRow(table.columns.map((c) => xlsxValue(c.type, row[c.key] ?? null)));
    }
    table.columns.forEach((col, idx) => {
      const column = ws.getColumn(idx + 1);
      const fmt = NUM_FMT[col.type];
      if (fmt) column.numFmt = fmt;
      column.alignment = { horizontal: isNumeric(col.type) ? "right" : "left" };
      column.width = Math.min(Math.max(col.header.length + 4, 12), 40);
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    if (table.rows.length === 0) ws.addRow([table.emptyMessage ?? "No rows"]);
  });

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

function csvCell(type: ExportFieldType, value: ExportCell): string {
  if (value === null || value === undefined) return "";
  if (type === "money") return dec(value).toFixed(2);
  if (type === "hours") return formatHours(value);
  if (type === "percent") return `${value}%`;
  return String(value);
}

function escapeCsv(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

export function buildCsv(tables: ExportTable[]): string {
  const blocks = tables.map((table) => {
    const lines: string[] = [];
    if (tables.length > 1 && table.title) lines.push(escapeCsv(table.title));
    lines.push(table.columns.map((c) => escapeCsv(c.header)).join(","));
    for (const row of table.rows) {
      lines.push(table.columns.map((c) => escapeCsv(csvCell(c.type, row[c.key] ?? null))).join(","));
    }
    if (table.rows.length === 0) lines.push(escapeCsv(table.emptyMessage ?? "No rows"));
    return lines.join("\r\n");
  });
  return blocks.join("\r\n\r\n");
}
