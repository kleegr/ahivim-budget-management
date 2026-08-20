import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { jsonError, redactError } from "@/lib/http";
import { individualScheduleSummary } from "@/lib/data/schedule-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Non-mutating: the authorised / used / scheduled / remaining-after-schedule
 * picture and pace for one individual, powering the planner's utilisation strip.
 * Any signed-in role may read. Returns `data: null` when no individual is given
 * or the individual has no record, so the strip simply hides.
 */
export async function GET(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const individualId = request.nextUrl.searchParams.get("individualId");
  if (!individualId || !/^[0-9a-f-]{36}$/i.test(individualId)) {
    return NextResponse.json({ ok: true, data: null });
  }

  try {
    const pool = getPool();
    const summary = await individualScheduleSummary(pool, individualId);
    return NextResponse.json({ ok: true, data: summary });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
