import { type NextRequest, NextResponse } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import {
  getAgencyFinancialReport,
  normalizeActualAgencyFinancialMonth,
} from "@/lib/data/agency-financial-report";
import { agencyFinancialExportTables } from "@/lib/export/agency-financial-report";
import { buildCsv, buildXlsx } from "@/lib/export/tabular";
import { jsonError, redactError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await apiUser("admin");
  if (!user) return jsonError("Only the owner can export agency financials.", 403);

  const url = new URL(request.url);
  const month = normalizeActualAgencyFinancialMonth(url.searchParams.get("month"));
  const format = url.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";

  try {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const report = await getAgencyFinancialReport(client, month);
      await client.query("COMMIT");

      const tables = agencyFinancialExportTables(report);
      const filename = `agency-financials-${report.month}.${format}`;
      if (format === "xlsx") {
        const buffer = await buildXlsx(`Agency financials - ${report.month}`, tables);
        return new NextResponse(buffer as BodyInit, {
          headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content-disposition": `attachment; filename="${filename}"`,
            "cache-control": "private, no-store",
          },
        });
      }

      return new NextResponse("\uFEFF" + buildCsv(tables), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "private, no-store",
        },
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return jsonError(redactError(error, "Agency financials could not be exported."), 500);
  }
}
