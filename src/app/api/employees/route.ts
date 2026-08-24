import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { hasDirectEmployeeAccess, resolveAccessScope } from "@/lib/auth/access";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { listEmployeesManaged, createEmployee, type EmployeeInput } from "@/lib/manage/employees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List employees for the management screens. Any signed-in role may read. */
export async function GET(request: NextRequest) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const includeArchived = url.searchParams.get("includeArchived") === "true";

  try {
    const pool = getPool();
    const scope = await resolveAccessScope(pool, user);
    const data = await listEmployeesManaged(pool, { status, search, includeArchived, scope });
    return NextResponse.json({
      ok: true,
      data: data.map((employee) => {
        if (scope.canSeeEmployeeDeals && hasDirectEmployeeAccess(scope, employee.id)) return employee;
        const visible = { ...employee };
        Reflect.deleteProperty(visible, "payoutCutPercent");
        return visible;
      }),
    });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/** Create an employee. Manager or admin only. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    const pool = getPool();
    const result = await createEmployee(pool, body as unknown as EmployeeInput, user.id, reason);
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
