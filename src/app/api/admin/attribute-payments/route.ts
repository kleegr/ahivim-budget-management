import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { backfillPaymentAttribution } from "@/lib/manage/payment-attribution";
import { refreshSettlementObligations } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const asUuid = (v: unknown): string | undefined =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())
    ? v.trim()
    : undefined;

/**
 * Back-fill employee-payment attribution onto the three newer columns, either
 * for every transaction or for one import batch. Administrator only. Never runs
 * during an import; this is a deliberate, auditable maintenance action.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("admin");
  if (!user) return jsonError("Administrator role required", 403);

  const body = await readJson(request);
  const batchId = asUuid(body.batchId) ?? null;

  try {
    const pool = getPool();
    const updated = await backfillPaymentAttribution(pool, { batchId }, user.id);
    const settlementRefresh = await refreshSettlementObligations(pool, {}, user.id);
    return NextResponse.json({
      ok: true,
      updated,
      batchId,
      settlements: settlementRefresh.ok ? settlementRefresh.data : null,
      settlementWarning: settlementRefresh.ok ? null : settlementRefresh.message,
    });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
