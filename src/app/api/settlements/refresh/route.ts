import { type NextRequest } from "next/server";
import { canOperateSettlementPerson, getSettlementOperator } from "@/lib/auth/settlement-operator";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { refreshSettlementObligations } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const operator = await getSettlementOperator();
  if (!operator) return jsonError("You do not have permission to refresh settlements.", 403);
  const { user, scope, pool } = operator;
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  const employeeId = body.employeeId ? String(body.employeeId) : null;
  const individualId = body.individualId ? String(body.individualId) : null;
  const scopedRefresh = Boolean(employeeId || individualId);
  const canRefreshGlobally = scope.full || (scope.allEmployees && scope.allIndividuals);
  const canRefresh = scopedRefresh
    ? (!employeeId || canOperateSettlementPerson(scope, { employeeId, individualId: null }))
      && (!individualId || canOperateSettlementPerson(scope, { employeeId: null, individualId }))
    : canRefreshGlobally;
  if (!canRefresh) return jsonError("You do not have permission to refresh that settlement scope.", 403);
  try {
    const result = await refreshSettlementObligations(
      pool,
      { employeeId, individualId },
      user.id,
      { allowGlobalWhenDirty: canRefreshGlobally },
    );
    return resultResponse(result);
  } catch (error) {
    return jsonError(redactError(error, "Settlement items could not be refreshed."), 500);
  }
}
