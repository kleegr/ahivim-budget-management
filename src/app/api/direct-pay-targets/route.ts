import type { NextRequest } from "next/server";
import { canOperateSettlementPerson, getSettlementOperator } from "@/lib/auth/settlement-operator";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { saveDirectPayTarget } from "@/lib/manage/direct-pay-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const operator = await getSettlementOperator();
  if (!operator) return jsonError("You do not have permission to manage direct-pay targets.", 403);
  if (!operator.scope.canSeeEmployeeAmounts) {
    return jsonError("Direct-pay target editing requires employee-amount access.", 403);
  }
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  const employeeId = String(body.employeeId ?? "");
  if (!canOperateSettlementPerson(operator.scope, { employeeId, individualId: null })) {
    return jsonError("You do not have permission to manage that employee.", 403);
  }
  try {
    return resultResponse(await saveDirectPayTarget(operator.pool, {
      id: body.id ? String(body.id) : null,
      employeeId,
      intervalUnit: String(body.intervalUnit ?? "week") as "week" | "month" | "custom",
      intervalCount: String(body.intervalCount ?? "1"),
      grossTargetAmount: String(body.grossTargetAmount ?? ""),
      planningHourlyRate: String(body.planningHourlyRate ?? ""),
      effectiveFrom: String(body.effectiveFrom ?? ""),
      effectiveTo: body.effectiveTo ? String(body.effectiveTo) : null,
      notes: body.notes ? String(body.notes) : null,
    }, operator.user.id), body.id ? 200 : 201);
  } catch (error) {
    return jsonError(redactError(error, "The direct-pay target could not be saved."), 500);
  }
}
