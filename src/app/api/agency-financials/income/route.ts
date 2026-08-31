import { type NextRequest, NextResponse } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import {
  createManualIncomeEntry,
  type ManualIncomeSource,
} from "@/lib/manage/agency-financials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await apiUser("admin");
  if (!user) return jsonError("Only the owner can record agency income.", 403);
  const crossOrigin = sameOriginOrFail(request);
  if (crossOrigin) return crossOrigin;
  const body = await readJson(request);
  try {
    const result = await createManualIncomeEntry(
      getPool(),
      {
        serviceDate: String(body.serviceDate ?? ""),
        sourceType: String(body.sourceType ?? "other") as ManualIncomeSource,
        individualId: body.individualId ? String(body.individualId) : null,
        programId: body.programId ? String(body.programId) : null,
        grossAmount: body.grossAmount,
        agencySharePercent: body.agencySharePercent,
        sourceRef: body.sourceRef ? String(body.sourceRef) : null,
        notes: body.notes ? String(body.notes) : null,
        overBudgetOverrideReason: body.overBudgetOverrideReason
          ? String(body.overBudgetOverrideReason)
          : null,
      },
      user.id,
    );
    if (!result.ok) return resultResponse(result);
    return NextResponse.json({ ok: true, data: result.data }, { status: 201 });
  } catch (error) {
    return jsonError(redactError(error, "The income could not be recorded."), 500);
  }
}
