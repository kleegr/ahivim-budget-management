import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { jsonError, redactError } from "@/lib/http";
import { suggestMatches, type AliasKind } from "@/lib/manage/aliases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Suggest canonical matches for an imported name. Any signed-in role may read. */
export async function GET(request: NextRequest) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  const url = new URL(request.url);
  const kind: AliasKind = url.searchParams.get("kind") === "employee" ? "employee" : "individual";
  const name = url.searchParams.get("name") ?? "";

  try {
    const pool = getPool();
    const data = await suggestMatches(pool, kind, name);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
