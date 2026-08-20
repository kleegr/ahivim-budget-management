import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { jsonError, redactError } from "@/lib/http";
import { dec, formatHours } from "@/lib/money";
import {
  REPORTS,
  isReportKey,
  selectFilters,
  type ReportFieldType,
  type ReportTable,
  type ReportCell,
} from "@/lib/data/report-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download a report as CSV or Excel.
 *
 *   GET /api/reports/<report>/export?format=csv|xlsx&<filters>
 *
 * `<report>` is validated against the whitelist of report keys, so the dynamic
 * segment can never select anything but a known report. Money and hours are
 * carried as decimal strings up to the presentation boundary here: CSV writes
 * the plain decimal, and Excel writes a number with a currency/hours format so
 * the sheet stays sortable. The four money quantities remain separate columns.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ report: string }> },
) {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { report } = await params;
  if (!isReportKey(report)) return jsonError("Unknown report", 404);

  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  const raw: Record<string, string | undefined> = {};
  for (const [k, v] of url.searchParams.entries()) raw[k] = v;
  const filters = selectFilters(report, raw);

  try {
    const def = REPORTS[report];
    const tables = await def.run(getPool(), filters);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${report}-${stamp}.${format}`;

    if (format === "xlsx") {
      const buffer = await buildXlsx(def.title, tables);
      return new NextResponse(buffer as BodyInit, {
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "no-store",
        },
      });
    }

    const csv = buildCsv(def.title, tables);
    // A BOM keeps accented names intact when the file is opened in Excel.
    return new NextResponse("﻿" + csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/* -------------------------------------------------------------------------- */
/* Cell formatting (one definition shared by both formats)                    */
/* -------------------------------------------------------------------------- */

/** CSV keeps money/hours as plain decimals so the file re-imports cleanly. */
function csvValue(type: ReportFieldType, value: ReportCell): string {
  if (value === null || value === undefined || value === "") return "";
  switch (type) {
    case "money":
      return dec(value).toFixed(2);
    case "hours":
      return formatHours(value);
    case "percent":
      return `${dec(value).toDecimalPlaces(1).toFixed(1)}%`;
    default:
      return String(value);
  }
}

function escapeCsv(field: string): string {
  if (/[",\r\n]/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

function buildCsv(reportTitle: string, tables: ReportTable[]): string {
  const multi = tables.length > 1;
  const blocks = tables.map((table) => {
    const lines: string[] = [];
    if (multi && table.title) lines.push(escapeCsv(table.title));
    lines.push(table.columns.map((c) => escapeCsv(c.header)).join(","));
    if (table.rows.length === 0) {
      lines.push(escapeCsv(table.emptyMessage ?? "No rows"));
    } else {
      for (const row of table.rows) {
        lines.push(
          table.columns.map((c) => escapeCsv(csvValue(c.type, row[c.key] ?? null))).join(","),
        );
      }
    }
    return lines.join("\r\n");
  });
  const header = `${reportTitle}`;
  return [escapeCsv(header), "", blocks.join("\r\n\r\n")].join("\r\n");
}

/* -------------------------------------------------------------------------- */
/* Excel                                                                       */
/* -------------------------------------------------------------------------- */

const NUM_FMT: Partial<Record<ReportFieldType, string>> = {
  money: "#,##0.00",
  hours: "#,##0.####",
  percent: "0.0%",
};

/** Excel cell value: numbers for money/hours/percent, strings otherwise. */
function xlsxValue(type: ReportFieldType, value: ReportCell): number | string | null {
  if (value === null || value === undefined || value === "") return null;
  switch (type) {
    case "money":
    case "hours":
      return dec(value).toNumber();
    case "percent":
      // Stored as a percent number (25 = 25%); Excel's percent format wants a
      // fraction, so divide once at the presentation boundary.
      return dec(value).dividedBy(100).toNumber();
    case "int":
      return typeof value === "number" ? value : Number(value);
    default:
      return String(value);
  }
}

function sheetName(name: string, index: number): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 28);
  return cleaned || `Sheet ${index + 1}`;
}

async function buildXlsx(reportTitle: string, tables: ReportTable[]): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ahivim Budget Management";
  wb.created = new Date();

  tables.forEach((table, i) => {
    const ws = wb.addWorksheet(sheetName(table.title ?? reportTitle, i));
    const header = ws.addRow(table.columns.map((c) => c.header));
    header.font = { bold: true };

    for (const row of table.rows) {
      ws.addRow(table.columns.map((c) => xlsxValue(c.type, row[c.key] ?? null)));
    }

    table.columns.forEach((col, idx) => {
      const column = ws.getColumn(idx + 1);
      const fmt = NUM_FMT[col.type];
      if (fmt) column.numFmt = fmt;
      column.alignment = { horizontal: numericType(col.type) ? "right" : "left" };
      // A readable default width based on the header length.
      column.width = Math.min(Math.max(col.header.length + 4, 12), 40);
    });

    if (table.rows.length === 0) {
      ws.addRow([table.emptyMessage ?? "No rows"]);
    }
  });

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

function numericType(type: ReportFieldType): boolean {
  return type === "money" || type === "hours" || type === "percent" || type === "int";
}
