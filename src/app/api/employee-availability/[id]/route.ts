import { NextRequest } from "next/server";
import { apiPlanningUser, planningEmployeeAllowed } from "@/lib/auth/planning-access";
import { getPool } from "@/lib/db";
import {
  jsonError,
  readJson,
  redactError,
  resultResponse,
  sameOriginOrFail,
} from "@/lib/http";
import {
  archiveEmployeeUnavailabilityWindow,
  archiveWeeklyAvailabilityWindow,
  getEmployeeUnavailabilityWindow,
  getWeeklyAvailabilityWindow,
} from "@/lib/manage/employee-availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Archive an availability rule without deleting its audit history. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);
  if (!planning.canManageAssignments) {
    return jsonError("Employee availability management access required", 403);
  }

  const { id } = await params;
  const body = await readJson(request);
  if (body.action !== "archive") return jsonError("Only archive is supported", 400);
  const reason = typeof body.reason === "string" ? body.reason : null;
  const pool = getPool();
  try {
    if (body.kind === "weekly") {
      const existing = await getWeeklyAvailabilityWindow(pool, id);
      if (!existing || !planningEmployeeAllowed(planning, existing.employeeId, "assignment", {
        from: existing.effectiveFrom,
        to: existing.effectiveTo,
      })) return jsonError("Not found", 404);
      return resultResponse(await archiveWeeklyAvailabilityWindow(pool, id, planning.user.id, reason));
    }
    if (body.kind === "unavailable") {
      const existing = await getEmployeeUnavailabilityWindow(pool, id);
      if (!existing || !planningEmployeeAllowed(planning, existing.employeeId, "assignment", {
        from: existing.startDate,
        to: existing.endDate,
      })) return jsonError("Not found", 404);
      return resultResponse(await archiveEmployeeUnavailabilityWindow(pool, id, planning.user.id, reason));
    }
    return jsonError("Choose the availability record type", 400);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
