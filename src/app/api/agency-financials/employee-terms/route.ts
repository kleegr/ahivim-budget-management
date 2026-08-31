import { type NextRequest, NextResponse } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { saveEmployeeIndividualCompensationTerm } from "@/lib/manage/agency-financials";
import { refreshSettlementObligations } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await apiUser("admin");
  if (!user) return jsonError("Only the owner can change employee pay rules.", 403);
  const crossOrigin = sameOriginOrFail(request);
  if (crossOrigin) return crossOrigin;
  const body = await readJson(request);
  try {
    const result = await saveEmployeeIndividualCompensationTerm(
      getPool(),
      {
        employeeId: String(body.employeeId ?? ""),
        individualId: String(body.individualId ?? ""),
        employeeSharePercent: body.employeeSharePercent,
        effectiveFrom: String(body.effectiveFrom ?? ""),
        effectiveTo: body.effectiveTo ? String(body.effectiveTo) : null,
        notes: body.notes ? String(body.notes) : null,
        reason: String(body.reason ?? ""),
      },
      user.id,
    );
    if (!result.ok) return resultResponse(result);
    const refreshed = await refreshSettlementObligations(
      getPool(),
      { employeeId: result.data.employeeId },
      user.id,
    );
    return NextResponse.json({
      ok: true,
      data: result.data,
      settlementWarning: refreshed.ok ? null : refreshed.message,
    }, { status: 201 });
  } catch (error) {
    return jsonError(redactError(error, "The employee pay rule could not be saved."), 500);
  }
}
