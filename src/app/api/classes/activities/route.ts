import { type NextRequest, NextResponse } from "next/server";
import { apiClassFinancialUser } from "@/lib/auth/class-financial-access";
import { classResultResponse } from "@/lib/class-response";
import { listClassActivities } from "@/lib/data/class-invoices";
import { jsonError, readJson, redactError, sameOriginOrFail } from "@/lib/http";
import { createClassActivity } from "@/lib/manage/class-invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await apiClassFinancialUser("view");
  if (!access) return jsonError("Class financial access required", 403);
  const includeInactive = access.scope.canManageClassInvoices
    && request.nextUrl.searchParams.get("includeInactive") === "true";
  try {
    return NextResponse.json({
      ok: true,
      data: await listClassActivities(access.pool, access.scope, includeInactive),
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not load class activities."), 500);
  }
}

export async function POST(request: NextRequest) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const access = await apiClassFinancialUser("manage");
  if (!access) return jsonError("Class invoice management access required", 403);
  const body = await readJson(request);
  try {
    return classResultResponse(await createClassActivity(access.pool, {
      code: String(body.code ?? ""),
      name: String(body.name ?? ""),
      description: typeof body.description === "string" ? body.description : null,
      defaultUnitPrice: body.defaultUnitPrice === undefined ? null : String(body.defaultUnitPrice),
      isActive: typeof body.isActive === "boolean" ? body.isActive : true,
      sortOrder: body.sortOrder === undefined ? null : Number(body.sortOrder),
    }, access.user.id, typeof body.reason === "string" ? body.reason : null), 201);
  } catch (error) {
    return jsonError(redactError(error, "Could not create that class activity."), 500);
  }
}
