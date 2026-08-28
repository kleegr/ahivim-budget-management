import { NextRequest, NextResponse } from "next/server";
import { apiPortalUser } from "@/lib/auth/portal-api";
import { createAgency, listAgencies, type AgencyInput } from "@/lib/manage/agencies";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const authorized = await apiPortalUser("agencies.manage");
    if (!authorized) return jsonError("Owner access required", 403);
    return NextResponse.json({ ok: true, data: await listAgencies(authorized.pool) });
  } catch (error) {
    return jsonError(redactError(error, "Could not load agencies."), 500);
  }
}

export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  try {
    const authorized = await apiPortalUser("agencies.manage");
    if (!authorized) return jsonError("Owner access required", 403);
    const body = await readJson(request);
    const result = await createAgency(
      authorized.pool,
      body as unknown as AgencyInput,
      authorized.user.id,
      typeof body.reason === "string" ? body.reason : null,
    );
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error, "Could not create that agency."), 500);
  }
}
