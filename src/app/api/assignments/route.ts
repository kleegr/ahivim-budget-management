import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { listAssignments, createAssignment, type AssignmentInput } from "@/lib/manage/assignments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List assignments, filterable by employee or individual. Any role may read. */
export async function GET(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const url = new URL(request.url);
  const employeeId = url.searchParams.get("employeeId") ?? undefined;
  const individualId = url.searchParams.get("individualId") ?? undefined;
  const includeInactive = url.searchParams.get("includeInactive") === "true";

  try {
    const pool = getPool();
    const data = await listAssignments(pool, { employeeId, individualId, includeInactive });
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/** Create an assignment. Manager or admin only. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    const pool = getPool();
    const result = await createAssignment(pool, body as unknown as AssignmentInput, user.id, reason);
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
