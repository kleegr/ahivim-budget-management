import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError } from "@/lib/http";
import {
  updateStrategy,
  explainStrategy,
  listStrategyRevisions,
  type UpdateStrategyInput,
} from "@/lib/manage/calculation-strategies";
import { refreshSettlementObligations } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Formula steps + change history for the detail panel. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);
  const { id } = await params;
  const pool = getPool();
  const [explain, revisions] = await Promise.all([explainStrategy(pool, id), listStrategyRevisions(pool, id)]);
  if (!explain) return jsonError("Strategy not found.", 404);
  return NextResponse.json({ ok: true, data: { explain, revisions } });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to edit strategies.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;
  const patch: UpdateStrategyInput = {
    id,
    ...(body.label !== undefined ? { label: String(body.label) } : {}),
    ...(body.renewalDate !== undefined ? { renewalDate: body.renewalDate === null ? null : String(body.renewalDate) } : {}),
    ...(body.monthDivisor !== undefined ? { monthDivisor: body.monthDivisor as string } : {}),
    ...(body.cut1Percent !== undefined ? { cut1Percent: body.cut1Percent as string } : {}),
    ...(body.cut2Percent !== undefined ? { cut2Percent: body.cut2Percent as string } : {}),
    ...(body.clockAdjustment !== undefined ? { clockAdjustment: body.clockAdjustment as string } : {}),
    ...(body.otherAdjustment !== undefined ? { otherAdjustment: body.otherAdjustment as string } : {}),
    ...(body.afterAll !== undefined ? { afterAll: body.afterAll as string } : {}),
    ...(body.account !== undefined ? { account: body.account === null ? null : String(body.account) } : {}),
    ...(body.notes !== undefined ? { notes: body.notes === null ? null : String(body.notes) } : {}),
    ...(body.hours !== undefined ? { hours: body.hours as Record<string, string> } : {}),
    ...(body.rateOverrides !== undefined ? { rateOverrides: body.rateOverrides as Record<string, string> } : {}),
  };
  const result = await updateStrategy(getPool(), patch, user.id, reason);
  if (!result.ok) return resultResponse(result);
  const pool = getPool();
  const computed = await explainStrategy(pool, id);
  const settlementRefresh = await refreshSettlementObligations(pool, {}, user.id);
  return NextResponse.json({
    ok: true,
    data: { id, computed },
    settlements: settlementRefresh.ok ? settlementRefresh.data : null,
    settlementWarning: settlementRefresh.ok ? null : settlementRefresh.message,
  });
}
