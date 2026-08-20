import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { jsonError, redactError } from "@/lib/http";
import { isUuid, listImportRows } from "@/lib/data/app-queries";
import { loadFile } from "@/lib/import/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Committed source rows for an import, filterable by review status. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  if (!isUuid(id)) return jsonError("Not found", 404);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  try {
    const pool = getPool();
    const file = await loadFile(pool, id);
    if (!file) return jsonError("Not found", 404);
    if (!file.committedBatchId) {
      return NextResponse.json({
        ok: true,
        committed: false,
        rows: [],
        total: 0,
        note: "This import is still staged. Source rows are stored when it is committed.",
      });
    }
    const result = await listImportRows(pool, file.committedBatchId, { status, limit, offset });
    return NextResponse.json({ ok: true, committed: true, ...result });
  } catch (error) {
    return jsonError(redactError(error, "Could not load those rows."), 500);
  }
}
