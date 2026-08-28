import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiPlanningUser, planningProgramAllowed, planningSubjectsAllowed } from "@/lib/auth/planning-access";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { listAssignments, createAssignment, type AssignmentInput } from "@/lib/manage/assignments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List assignments for an account with Planning access. */
export async function GET(request: NextRequest) {
  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);

  const url = new URL(request.url);
  const employeeId = url.searchParams.get("employeeId") ?? undefined;
  const individualId = url.searchParams.get("individualId") ?? undefined;
  const includeInactive = url.searchParams.get("includeInactive") === "true";

  try {
    const pool = getPool();
    const data = (await listAssignments(pool, {
      employeeId,
      individualId,
      includeInactive,
      scope: planning.access,
      hoursOnlyPrograms: planning.agencyIds.length > 0,
    })).filter((row) => planningSubjectsAllowed(planning, {
      individualIds: [row.individualId],
      employeeId: row.employeeId,
    }, "read", { from: row.startDate, to: row.endDate }));
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/** Create an hours-only employee assignment. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);
  const { user } = planning;

  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;
  if (!planning.canManageAssignments) return jsonError("Assignment management access required", 403);
  const input = body as unknown as AssignmentInput;
  if (!planningSubjectsAllowed(planning, {
    individualIds: [input.individualId],
    employeeId: input.employeeId,
  }, "assignment", { from: input.startDate ?? null, to: input.endDate ?? null })) return jsonError("That assignment range is outside your agency roster.", 403);

  try {
    const pool = getPool();
    if (!await planningProgramAllowed(pool, planning, input.programId)) {
      return jsonError("Choose an active hours-based planning program.", 403);
    }
    const result = await createAssignment(pool, input, user.id, reason);
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
