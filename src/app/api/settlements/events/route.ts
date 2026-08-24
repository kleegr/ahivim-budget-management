import { type NextRequest } from "next/server";
import { canOperateSettlementObligations, getSettlementOperator } from "@/lib/auth/settlement-operator";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { applySettlementCredit, recordObligationPayment, settleObligations } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const operator = await getSettlementOperator();
  if (!operator) return jsonError("You do not have permission to record money activity.", 403);
  const { user, scope, pool } = operator;
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  const occurredOn = String(body.occurredOn ?? new Date().toISOString().slice(0, 10));
  try {
    if (body.action === "settle") {
      const obligationIds = Array.isArray(body.obligationIds)
        ? body.obligationIds.map(String)
        : [];
      if (!await canOperateSettlementObligations(pool, scope, obligationIds)) {
        return jsonError("You do not have permission to record those balances.", 403);
      }
      return resultResponse(await settleObligations(pool, {
        obligationIds,
        occurredOn,
        operationKey: String(body.operationKey ?? ""),
        reference: body.reference ? String(body.reference) : null,
        note: body.note ? String(body.note) : null,
      }, user.id));
    }
    if (body.action === "payment") {
      const obligationId = String(body.obligationId ?? "");
      if (!await canOperateSettlementObligations(pool, scope, [obligationId])) {
        return jsonError("You do not have permission to record that balance.", 403);
      }
      return resultResponse(await recordObligationPayment(pool, {
        obligationId,
        amount: String(body.amount ?? ""),
        occurredOn,
        operationKey: String(body.operationKey ?? ""),
        reference: body.reference ? String(body.reference) : null,
        note: body.note ? String(body.note) : null,
      }, user.id));
    }
    if (body.action === "apply_credit") {
      const sourceObligationId = String(body.sourceObligationId ?? "");
      const targetObligationId = String(body.targetObligationId ?? "");
      if (!await canOperateSettlementObligations(pool, scope, [sourceObligationId, targetObligationId])) {
        return jsonError("You do not have permission to apply that credit.", 403);
      }
      return resultResponse(await applySettlementCredit(pool, {
        sourceObligationId,
        targetObligationId,
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
