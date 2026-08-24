import { type NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { percentToFraction, saveEmployeeDeal, type DirectDealRule } from "@/lib/manage/employee-deals";
import { refreshSettlementObligations } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to change employee deals.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  try {
    const result = await saveEmployeeDeal(
      getPool(),
      {
        employeeId: String(body.employeeId ?? ""),
        directRule: String(body.directRule ?? "keep_all") as DirectDealRule,
        directPercent: percentToFraction(body.directPercent),
        agencyCutPercent: percentToFraction(body.agencyCutPercent),
        effectiveFrom: String(body.effectiveFrom ?? new Date().toISOString().slice(0, 10)),
        effectiveTo: body.effectiveTo ? String(body.effectiveTo) : null,
        notes: body.notes ? String(body.notes) : null,
        reason: String(body.reason ?? ""),
      },
      user.id,
    );
    if (!result.ok) return resultResponse(result);
    const settlementRefresh = await refreshSettlementObligations(getPool(), {}, user.id);
    return NextResponse.json({
      ok: true,
      data: result.data,
      settlements: settlementRefresh.ok ? settlementRefresh.data : null,
      settlementWarning: settlementRefresh.ok ? null : settlementRefresh.message,
    }, { status: 201 });
  } catch (error) {
    return jsonError(redactError(error, "The deal could not be saved."), 500);
  }
}
