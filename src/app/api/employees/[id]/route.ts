import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { resolveAccessScope, canViewEmployee, hasDirectEmployeeAccess, isPlanningOnlyAccess } from "@/lib/auth/access";
import { planningEmployeeProfile } from "@/lib/auth/employee-planning-access";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import {
  getEmployee,
  updateEmployee,
  setEmployeeStatus,
  type EmployeeInput,
  type EmployeeStatus,
} from "@/lib/manage/employees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read a single employee. Any signed-in role may read. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  const { id } = await params;
  try {
    const pool = getPool();
    const scope = await resolveAccessScope(pool, user);
    if (!canViewEmployee(scope, id)) return jsonError("Not found", 404);
    const record = await getEmployee(pool, id);
    if (!record) return jsonError("Not found", 404);
    if (isPlanningOnlyAccess(scope)) {
      return NextResponse.json({ ok: true, data: planningEmployeeProfile(record) });
    }
    if (scope.canSeeEmployeeDeals && hasDirectEmployeeAccess(scope, id)) {
      return NextResponse.json({ ok: true, data: record });
    }
    const visible = { ...record };
    Reflect.deleteProperty(visible, "payoutCutPercent");
    return NextResponse.json({ ok: true, data: visible });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/**
 * Update an employee, or move it through its lifecycle. A `body.action` of
 * archive / deactivate / restore changes status; anything else is treated as a
 * field edit. Manager or admin only.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;
  const action = body.action;

  try {
    const pool = getPool();
    if (action === "archive" || action === "deactivate" || action === "restore") {
      const status: EmployeeStatus =
        action === "restore" ? "active" : action === "archive" ? "archived" : "inactive";
      const result = await setEmployeeStatus(pool, id, status, user.id, reason);
      return resultResponse(result, 200);
    }
    const result = await updateEmployee(pool, id, body as unknown as EmployeeInput, user.id, reason);
    return resultResponse(result, 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
