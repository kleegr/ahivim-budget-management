import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiPlanningUser, planningProgramAllowed, planningSubjectsAllowed } from "@/lib/auth/planning-access";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { getAssignment, updateAssignment, setAssignmentStatus, type AssignmentInput } from "@/lib/manage/assignments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update an assignment, or change its status. A `body.action` of end / archive
 * / reactivate changes status; anything else is treated as a field edit.
 * Available to a dedicated planner without granting financial access.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);
  const { user } = planning;
  if (!planning.canManageAssignments) return jsonError("Assignment management access required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;
  const action = body.action;

  try {
    const pool = getPool();
    const existing = await getAssignment(pool, id);
    if (!existing || !planningSubjectsAllowed(planning, {
      individualIds: [existing.individualId],
      employeeId: existing.employeeId,
    }, "assignment", { from: existing.startDate, to: existing.endDate })) return jsonError("Not found", 404);
    if (!await planningProgramAllowed(pool, planning, existing.programId, { allowInactive: true })) {
      return jsonError("Not found", 404);
    }
    if (action === "end" || action === "archive") {
      const status: "ended" | "archived" = action === "end" ? "ended" : "archived";
      const result = await setAssignmentStatus(pool, id, status, user.id, reason);
      return resultResponse(result, 200);
    }
    const proposed = body as unknown as Partial<AssignmentInput>;
    if (!planningSubjectsAllowed(planning, {
      individualIds: [proposed.individualId ?? existing.individualId],
      employeeId: proposed.employeeId ?? existing.employeeId,
    }, "assignment", {
      from: proposed.startDate === undefined ? existing.startDate : proposed.startDate,
      to: proposed.endDate === undefined ? existing.endDate : proposed.endDate,
    })) return jsonError("That assignment range is outside your agency roster.", 403);
    if (!await planningProgramAllowed(pool, planning, proposed.programId ?? existing.programId)) {
      return jsonError("Choose an active hours-based planning program.", 403);
    }
    if (action === "reactivate") {
      const result = await setAssignmentStatus(pool, id, "active", user.id, reason);
      return resultResponse(result, 200);
    }
    const result = await updateAssignment(pool, id, proposed, user.id, reason);
    return resultResponse(result, 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
