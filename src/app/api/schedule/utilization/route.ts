import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiPlanningUser, planningSubjectsAllowed } from "@/lib/auth/planning-access";
import { jsonError, redactError } from "@/lib/http";
import { individualScheduleSummary } from "@/lib/data/schedule-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Non-mutating: the authorised / used / scheduled / remaining-after-schedule
 * picture and pace for one individual, powering the planner's utilisation strip.
 * Planning access is required. Returns `data: null` when no individual is given
 * or the individual has no record, so the strip simply hides.
 */
export async function GET(request: NextRequest) {
  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);

  const individualId = request.nextUrl.searchParams.get("individualId");
  if (!individualId || !/^[0-9a-f-]{36}$/i.test(individualId)) {
    return NextResponse.json({ ok: true, data: null });
  }
  if (!planningSubjectsAllowed(planning, { individualIds: [individualId], employeeId: null })) {
    return jsonError("Not found", 404);
  }

  try {
    const pool = getPool();
    const summary = await individualScheduleSummary(pool, individualId, new Date(), planning.agencyIds.length > 0);
    return NextResponse.json({ ok: true, data: summary });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
