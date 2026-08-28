import { NextRequest, NextResponse } from "next/server";
import { apiPortalUser } from "@/lib/auth/portal-api";
import { portalPolicyFromInput } from "@/lib/auth/portal-policy-input";
import {
  listIndividualPortalAssignments,
  setIndividualPortalAssignment,
  type IndividualPortalAssignmentInput,
} from "@/lib/manage/portal-identities";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const authorized = await apiPortalUser("users.manage");
    if (!authorized) return jsonError("Owner access required", 403);
    return NextResponse.json({ ok: true, data: await listIndividualPortalAssignments(authorized.pool) });
  } catch (error) {
    return jsonError(redactError(error, "Could not load individual portal access."), 500);
  }
}

export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  try {
    const authorized = await apiPortalUser("users.manage");
    if (!authorized) return jsonError("Owner access required", 403);
    const body = await readJson(request);
    const result = await setIndividualPortalAssignment(
      authorized.pool,
      { ...body, ...portalPolicyFromInput(body, "self") } as unknown as IndividualPortalAssignmentInput,
      authorized.user.id,
      typeof body.reason === "string" ? body.reason : null,
    );
    return resultResponse(result);
  } catch (error) {
    return jsonError(redactError(error, "Could not update individual portal access."), 500);
  }
}
