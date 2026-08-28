import { NextRequest, NextResponse } from "next/server";
import { apiPortalUser } from "@/lib/auth/portal-api";
import { portalPolicyFromInput } from "@/lib/auth/portal-policy-input";
import {
  listAgencyUserAccess,
  setAgencyUserAccess,
  type AgencyUserAccessInput,
} from "@/lib/manage/agencies";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authorized = await apiPortalUser("agencies.manage");
    if (!authorized) return jsonError("Owner access required", 403);
    const { id } = await params;
    return NextResponse.json({ ok: true, data: await listAgencyUserAccess(authorized.pool, id) });
  } catch (error) {
    return jsonError(redactError(error, "Could not load agency access."), 500);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  try {
    const authorized = await apiPortalUser("agencies.manage");
    if (!authorized) return jsonError("Owner access required", 403);
    const { id } = await params;
    const body = await readJson(request);
    const policy = portalPolicyFromInput(body, "agency");
    const result = await setAgencyUserAccess(
      authorized.pool,
      id,
      { ...body, ...policy } as unknown as AgencyUserAccessInput,
      authorized.user.id,
      typeof body.reason === "string" ? body.reason : null,
    );
    return resultResponse(result);
  } catch (error) {
    return jsonError(redactError(error, "Could not update agency access."), 500);
  }
}
