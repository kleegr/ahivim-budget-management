import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { resolveAccessScope } from "@/lib/auth/access";
import { readJson, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { agencyDate } from "@/lib/business/agency-time";
import { transactionFieldVisibility } from "@/lib/auth/money-redaction";
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
    if (columns.length > 100) return jsonError("Too many columns to export.", 400);
    const visibility = transactionFieldVisibility(scope);
    const permitted = new Set([
      "id", "individualId", "employeeId", "programId", "checkIdentity", "sourcePaymentIdentity",
      "serviceDate", "payTo", "checkDate", "checkNumber", "periodBegin", "periodEnd", "programCode", "program",
      "individual", "employee", "paid", "paymentRecipient", "nextStep", "matchStatus", "groupStatus",
      "sourceName", "sourceSheet", "sourceRowNumber", "routing", "individuals", "programs", "services",
      "employees", "employeeChecks", "review",
      ...(visibility.canSeeHours ? ["hours"] : []),
      ...(visibility.canSeeBilledAmounts ? ["rate", "gross", "funderBilled", "funderBilledCompleteness"] : []),
      ...(visibility.canSeeEmployeeAmounts ? ["employeeRate", "internalAmount", "employeeBase", "employeeBaseCompleteness"] : []),
      ...(visibility.canSeeAgencySpread ? ["agencyAdditional", "agencySpread", "agencySpreadCompleteness"] : []),
      ...(visibility.canSeeBilledAmounts && visibility.canSeeEmployeeAmounts ? ["moneyReconciliation"] : []),
      ...(visibility.canSeeCheckGross ? ["verifiedCheckGross", "verifiedGross"] : []),
      ...(visibility.canSeeCheckNet ? ["verifiedCheckNet", "verifiedNet", "totalNetPay", "sourceNet"] : []),
      ...(visibility.canSeeCheckGross || visibility.canSeeCheckNet ? ["verificationStatus", "verification"] : []),
      ...(visibility.canSeeTaxes ? ["withholding"] : []),
    ]);
    if (columns.some((column) => !permitted.has(column.key))) {
      return jsonError("One or more requested fields are outside your transaction access.", 403);
    }

    const rawRows = Array.isArray(body.rows) ? body.rows : [];
    if (rawRows.length > 200_000) return jsonError("Too many rows to export at once.", 400);
    const rows: Record<string, ExportCell>[] = [];
    for (const r of rawRows) {
      if (!r || typeof r !== "object" || Array.isArray(r)) return jsonError("Invalid export row.", 400);
      const src = r as Record<string, unknown>;
      const out: Record<string, ExportCell> = {};
      for (const col of columns) {
        const v = src[col.key];
        if (v !== null && v !== undefined && !["string", "number", "boolean"].includes(typeof v)) return jsonError("Invalid export cell.", 400);
        if (typeof v === "number" && !Number.isFinite(v)) return jsonError("Invalid export number.", 400);
        if (typeof v === "string" && v.length > 32_767) return jsonError("An export cell is too long.", 400);
        out[col.key] = v === null || v === undefined ? null : typeof v === "boolean" ? String(v) : (v as ExportCell);
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
