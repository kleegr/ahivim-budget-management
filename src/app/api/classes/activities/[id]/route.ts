import { type NextRequest } from "next/server";
import { apiClassFinancialUser } from "@/lib/auth/class-financial-access";
import { classResultResponse } from "@/lib/class-response";
import { jsonError, readJson, redactError, sameOriginOrFail } from "@/lib/http";
import { updateClassActivity } from "@/lib/manage/class-invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const access = await apiClassFinancialUser("manage");
  if (!access) return jsonError("Class invoice management access required", 403);
  const body = await readJson(request);
  const { id } = await params;
  try {
    return classResultResponse(await updateClassActivity(access.pool, id, {
      code: String(body.code ?? ""),
      name: String(body.name ?? ""),
      description: typeof body.description === "string" ? body.description : null,
      defaultUnitPrice: body.defaultUnitPrice === undefined ? null : String(body.defaultUnitPrice),
      isActive: typeof body.isActive === "boolean" ? body.isActive : true,
      sortOrder: body.sortOrder === undefined ? null : Number(body.sortOrder),
    }, access.user.id, typeof body.reason === "string" ? body.reason : null));
  } catch (error) {
    return jsonError(redactError(error, "Could not update that class activity."), 500);
  }
}
