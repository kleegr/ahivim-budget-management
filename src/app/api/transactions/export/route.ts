import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { resolveAccessScope } from "@/lib/auth/access";
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

/**
 * Export the currently filtered grid view. The client already holds the whole
 * ledger in memory, so it posts the exact filtered/sorted rows and visible
 * columns it is showing — what you see is what you export.
 */
export async function POST(request: NextRequest) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Sign in to continue.", 401);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;

  try {
    const scope = await resolveAccessScope(getPool(), user);
    if (!scope.canSeeTransactions) return jsonError("No access to transactions", 403);

    const body = await readJson(request);
    const format = body.format === "xlsx" ? "xlsx" : "csv";
    const title = typeof body.title === "string" && body.title ? body.title : "Transactions";
    const baseName = typeof body.filename === "string" && body.filename ? body.filename : "transactions";

    const rawColumns = Array.isArray(body.columns) ? body.columns : [];
    const columns: ExportColumn[] = rawColumns
      .map((c): ExportColumn | null => {
        if (!c || typeof c !== "object") return null;
        const col = c as Record<string, unknown>;
        const key = typeof col.key === "string" ? col.key : null;
        const header = typeof col.header === "string" ? col.header : key;
        const type = FIELD_TYPES.has(col.type as ExportFieldType)
          ? (col.type as ExportFieldType)
          : "text";
        return key && header ? { key, header, type } : null;
      })
      .filter((c): c is ExportColumn => c !== null);

    if (columns.length === 0) return jsonError("No columns to export.", 400);

    const rawRows = Array.isArray(body.rows) ? body.rows : [];
    if (rawRows.length > 200_000) return jsonError("Too many rows to export at once.", 400);
    const rows: Record<string, ExportCell>[] = rawRows.map((r) => {
      const src = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      const out: Record<string, ExportCell> = {};
      for (const col of columns) {
        const v = src[col.key];
        out[col.key] = v === null || v === undefined ? null : (v as ExportCell);
      }
      return out;
    });

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
