import { NextResponse, type NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { readJson, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { agencyDate } from "@/lib/business/agency-time";
import {
  buildXlsx,
  buildCsv,
  type ExportColumn,
  type ExportCell,
  type ExportFieldType,
} from "@/lib/export/tabular";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIELD_TYPES: ReadonlySet<ExportFieldType> = new Set([
  "text",
  "date",
  "money",
  "hours",
  "int",
  "percent",
]);
const MAX_BODY_BYTES = 20_000_000;
const MAX_COLUMNS = 100;
const MAX_ROWS = 200_000;
const MAX_CELLS = 2_000_000;
const MAX_CELL_CHARACTERS = 32_767;

/**
 * Generic "export the filtered view" endpoint for any client-side grid. The
 * grid holds its whole (small) result set in memory, so it posts the exact
 * columns and filtered/sorted rows it is showing — what you see is what you
 * export. A near-twin of the transactions exporter, kept separate so either can
 * evolve without disturbing the other.
 */
export async function POST(request: NextRequest) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Sign in to continue.", 401);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) {
    return jsonError("Export payload is too large.", 413);
  }

  try {
    const body = await readJson(request);
    const format = body.format === "xlsx" ? "xlsx" : "csv";
    const title = typeof body.title === "string" && body.title
      ? body.title.slice(0, 120)
      : "Report";
    const requestedName = typeof body.filename === "string" && body.filename ? body.filename : "report";
    const baseName = requestedName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "report";

    const rawColumns = Array.isArray(body.columns) ? body.columns : [];
    if (rawColumns.length > MAX_COLUMNS) return jsonError("Too many columns to export at once.", 400);
    const columns: ExportColumn[] = rawColumns
      .map((c): ExportColumn | null => {
        if (!c || typeof c !== "object") return null;
        const col = c as Record<string, unknown>;
        const key = typeof col.key === "string" ? col.key : null;
        const header = typeof col.header === "string" ? col.header : key;
        const type = FIELD_TYPES.has(col.type as ExportFieldType)
          ? (col.type as ExportFieldType)
          : "text";
        return key && header && key.length <= 200 && header.length <= 200
          ? { key, header, type }
          : null;
      })
      .filter((c): c is ExportColumn => c !== null);

    if (columns.length === 0) return jsonError("No columns to export.", 400);

    const rawRows = Array.isArray(body.rows) ? body.rows : [];
    if (rawRows.length > MAX_ROWS) return jsonError("Too many rows to export at once.", 400);
    if (rawRows.length * columns.length > MAX_CELLS) {
      return jsonError("Too many cells to export at once.", 400);
    }
    let characterCount = 0;
    const rows: Record<string, ExportCell>[] = [];
    for (const r of rawRows) {
      const src = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      const out: Record<string, ExportCell> = {};
      for (const col of columns) {
        const v = src[col.key];
        if (v === null || v === undefined) {
          out[col.key] = null;
          continue;
        }
        if (typeof v !== "string" && (typeof v !== "number" || !Number.isFinite(v))) {
          return jsonError("Export cells must contain text or finite numbers.", 400);
        }
        if (typeof v === "string") {
          if (v.length > MAX_CELL_CHARACTERS) return jsonError("An export cell is too long.", 400);
          characterCount += v.length;
          if (characterCount > MAX_BODY_BYTES) return jsonError("Export payload is too large.", 413);
        }
        out[col.key] = v;
      }
      rows.push(out);
    }

    const filename = `${baseName}-${agencyDate()}.${format}`;

    if (format === "xlsx") {
      const buffer = await buildXlsx(title, [{ title, columns, rows }]);
      return new NextResponse(buffer as BodyInit, {
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "no-store",
        },
      });
    }

    const csv = "﻿" + buildCsv([{ title, columns, rows }]);
    return new NextResponse(csv, {
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
