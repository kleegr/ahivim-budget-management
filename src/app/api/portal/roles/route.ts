import { NextRequest, NextResponse } from "next/server";
import { isGlobalPortalRole } from "@/lib/auth/portal-access";
import { apiPortalUser } from "@/lib/auth/portal-api";
import {
  listGlobalPortalRoleAssignments,
  setGlobalPortalRoleAssignment,
} from "@/lib/manage/portal-identities";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const authorized = await apiPortalUser("users.manage");
    if (!authorized) return jsonError("Owner access required", 403);
    return NextResponse.json({ ok: true, data: await listGlobalPortalRoleAssignments(authorized.pool) });
  } catch (error) {
    return jsonError(redactError(error, "Could not load portal roles."), 500);
  }
}

export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  try {
    const authorized = await apiPortalUser("users.manage");
    if (!authorized) return jsonError("Owner access required", 403);
    const body = await readJson(request);
    const role = String(body.role ?? "");
    if (!isGlobalPortalRole(role)) return jsonError("Choose a valid portal role.", 400);
    const result = await setGlobalPortalRoleAssignment(
      authorized.pool,
      {
        userId: String(body.userId ?? ""),
        role,
        isActive: body.isActive === undefined ? true : body.isActive === true || body.isActive === "true",
      },
      authorized.user.id,
      typeof body.reason === "string" ? body.reason : null,
    );
    return resultResponse(result);
  } catch (error) {
    return jsonError(redactError(error, "Could not update the portal role."), 500);
  }
}
