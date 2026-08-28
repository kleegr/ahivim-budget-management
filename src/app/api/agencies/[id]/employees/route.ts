import { NextRequest, NextResponse } from "next/server";
import { apiPortalUser } from "@/lib/auth/portal-api";
import { listAgencyEmployeeMemberships, setAgencyEmployeeMembership } from "@/lib/manage/agencies";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authorized = await apiPortalUser("agencies.manage");
    if (!authorized) return jsonError("Owner access required", 403);
    const { id } = await params;
    return NextResponse.json({ ok: true, data: await listAgencyEmployeeMemberships(authorized.pool, id) });
  } catch (error) {
    return jsonError(redactError(error, "Could not load the agency employee roster."), 500);
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
    const result = await setAgencyEmployeeMembership(
      authorized.pool,
      id,
      {
        membershipId: typeof body.membershipId === "string" && body.membershipId ? body.membershipId : undefined,
        employeeId: String(body.employeeId ?? ""),
        isActive: body.isActive === undefined ? true : body.isActive === true || body.isActive === "true",
        effectiveFrom: typeof body.effectiveFrom === "string" && body.effectiveFrom ? body.effectiveFrom : undefined,
        effectiveTo: typeof body.effectiveTo === "string" && body.effectiveTo ? body.effectiveTo : null,
      },
      authorized.user.id,
      typeof body.reason === "string" ? body.reason : null,
    );
    return resultResponse(result);
  } catch (error) {
    return jsonError(redactError(error, "Could not update the agency employee roster."), 500);
  }
}
