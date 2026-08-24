import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError } from "@/lib/http";
import { createStrategy } from "@/lib/manage/calculation-strategies";
import { refreshSettlementObligations } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to add strategies.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  const pool = getPool();
  const result = await createStrategy(
    pool,
    { individualId: String(body.individualId ?? ""), label: body.label ? String(body.label) : undefined },
    user.id,
  );
  if (!result.ok) return resultResponse(result);
  const settlementRefresh = await refreshSettlementObligations(pool, {}, user.id);
  return NextResponse.json({
    ok: true,
    data: result.data,
    settlements: settlementRefresh.ok ? settlementRefresh.data : null,
    settlementWarning: settlementRefresh.ok ? null : settlementRefresh.message,
  }, { status: 201 });
}
