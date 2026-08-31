import { NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { resolvePortalAccess } from "@/lib/auth/portal-access";
import { getPool } from "@/lib/db";
import { getPortalIndividualStatement } from "@/lib/data/portal-individual-statement";
import {
  portalIndividualStatementCsv,
  portalIndividualStatementHtml,
  portalStatementFilename,
  type PortalStatementScope,
} from "@/lib/export/portal-individual-statement";
import { jsonError, redactError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  const url = new URL(request.url);
  const individualId = url.searchParams.get("individualId") ?? "";
  const month = url.searchParams.get("month");
  const scope: PortalStatementScope = url.searchParams.get("scope") === "month" ? "month" : "trend";
  const format = url.searchParams.get("format") === "html" ? "html" : "csv";
  const requestedMonths = Number(url.searchParams.get("months") ?? 12);
  const monthCount = Number.isFinite(requestedMonths) ? requestedMonths : 12;

  try {
    const pool = getPool();
    const access = await resolvePortalAccess(pool, user);
    const statement = await getPortalIndividualStatement(
      pool,
      access,
      individualId,
      month,
      monthCount,
    );
    if (!statement) return jsonError("Statement not found", 404);
    if (!Object.values(statement.visibility).some(Boolean)) {
      return jsonError("No statement categories are available", 403);
    }

    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    if (format === "html") {
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Content-Disposition", `inline; filename="${portalStatementFilename(statement, scope, "html")}"`);
      headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
      return new Response(portalIndividualStatementHtml(statement, scope), { headers });
    }

    headers.set("Content-Type", "text/csv; charset=utf-8");
    headers.set("Content-Disposition", `attachment; filename="${portalStatementFilename(statement, scope, "csv")}"`);
    return new Response(portalIndividualStatementCsv(statement, scope), { headers });
  } catch (error) {
    return jsonError(redactError(error, "Could not prepare this statement."), 500);
  }
}
