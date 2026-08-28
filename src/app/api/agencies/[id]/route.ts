import { NextRequest, NextResponse } from "next/server";
import { apiPortalUser } from "@/lib/auth/portal-api";
import { getAgency, updateAgency, type AgencyInput } from "@/lib/manage/agencies";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authorized = await apiPortalUser("agencies.manage");
    if (!authorized) return jsonError("Owner access required", 403);
    const { id } = await params;
    const agency = await getAgency(authorized.pool, id);
    return agency
      ? NextResponse.json({ ok: true, data: agency })
      : jsonError("Not found", 404);
  } catch (error) {
    return jsonError(redactError(error, "Could not load that agency."), 500);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  try {
    const authorized = await apiPortalUser("agencies.manage");
    if (!authorized) return jsonError("Owner access required", 403);
    const { id } = await params;
    const body = await readJson(request);
    const result = await updateAgency(
      authorized.pool,
      id,
      body as Partial<AgencyInput>,
      authorized.user.id,
      typeof body.reason === "string" ? body.reason : null,
    );
    return resultResponse(result);
  } catch (error) {
    return jsonError(redactError(error, "Could not update that agency."), 500);
  }
}
