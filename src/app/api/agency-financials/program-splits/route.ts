import { type NextRequest, NextResponse } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { saveProgramRevenueTerm } from "@/lib/manage/agency-financials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await apiUser("admin");
  if (!user) return jsonError("Only the owner can change program splits.", 403);
  const crossOrigin = sameOriginOrFail(request);
  if (crossOrigin) return crossOrigin;
  const body = await readJson(request);
  try {
    const result = await saveProgramRevenueTerm(
      getPool(),
      {
        individualId: String(body.individualId ?? ""),
        programId: String(body.programId ?? ""),
        agencySharePercent: body.agencySharePercent,
        effectiveFrom: String(body.effectiveFrom ?? ""),
        effectiveTo: body.effectiveTo ? String(body.effectiveTo) : null,
        notes: body.notes ? String(body.notes) : null,
        reason: String(body.reason ?? ""),
      },
      user.id,
    );
    if (!result.ok) return resultResponse(result);
    return NextResponse.json({ ok: true, data: result.data }, { status: 201 });
  } catch (error) {
    return jsonError(redactError(error, "The program split could not be saved."), 500);
  }
}
