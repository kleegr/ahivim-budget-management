import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiPlanningUser } from "@/lib/auth/planning-access";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { updateAssignment, setAssignmentStatus, type AssignmentInput } from "@/lib/manage/assignments";

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

  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;
  const action = body.action;

  try {
    const pool = getPool();
    if (action === "end" || action === "archive" || action === "reactivate") {
      const status: "active" | "ended" | "archived" =
        action === "end" ? "ended" : action === "archive" ? "archived" : "active";
      const result = await setAssignmentStatus(pool, id, status, user.id, reason);
      return resultResponse(result, 200);
    }
    const result = await updateAssignment(pool, id, body as unknown as Partial<AssignmentInput>, user.id, reason);
    return resultResponse(result, 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
