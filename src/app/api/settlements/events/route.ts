import { type NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { applySettlementCredit, recordObligationPayment, settleObligations } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to record settlements.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  const occurredOn = String(body.occurredOn ?? new Date().toISOString().slice(0, 10));
  try {
    if (body.action === "settle") {
      const obligationIds = Array.isArray(body.obligationIds)
        ? body.obligationIds.map(String)
        : [];
      return resultResponse(await settleObligations(getPool(), {
        obligationIds,
        occurredOn,
        operationKey: String(body.operationKey ?? ""),
        reference: body.reference ? String(body.reference) : null,
        note: body.note ? String(body.note) : null,
      }, user.id));
    }
    if (body.action === "payment") {
      return resultResponse(await recordObligationPayment(getPool(), {
        obligationId: String(body.obligationId ?? ""),
        amount: String(body.amount ?? ""),
        occurredOn,
        operationKey: String(body.operationKey ?? ""),
        reference: body.reference ? String(body.reference) : null,
        note: body.note ? String(body.note) : null,
      }, user.id));
    }
    if (body.action === "apply_credit") {
      return resultResponse(await applySettlementCredit(getPool(), {
        sourceObligationId: String(body.sourceObligationId ?? ""),
        targetObligationId: String(body.targetObligationId ?? ""),
        amount: String(body.amount ?? ""),
        occurredOn,
        operationKey: String(body.operationKey ?? ""),
        reference: body.reference ? String(body.reference) : null,
        note: body.note ? String(body.note) : null,
      }, user.id));
    }
    return jsonError("Choose a settlement action.", 400);
  } catch (error) {
    return jsonError(redactError(error, "The settlement could not be recorded."), 500);
  }
}
