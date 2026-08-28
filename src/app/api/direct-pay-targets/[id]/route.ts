import type { NextRequest } from "next/server";
import { canOperateSettlementPerson, getSettlementOperator } from "@/lib/auth/settlement-operator";
import { jsonError, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { archiveDirectPayTarget } from "@/lib/manage/direct-pay-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const operator = await getSettlementOperator();
  if (!operator) return jsonError("You do not have permission to archive direct-pay targets.", 403);
  if (!operator.scope.canSeeEmployeeAmounts) {
    return jsonError("Direct-pay target editing requires employee-amount access.", 403);
  }
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  try {
    const target = await operator.pool.query<{ employee_id: string }>(
      `SELECT employee_id FROM employee_direct_pay_targets WHERE id = $1`,
      [id],
    );
    if (!target.rows[0]) return jsonError("That direct-pay target no longer exists.", 404);
    if (!canOperateSettlementPerson(operator.scope, { employeeId: target.rows[0].employee_id, individualId: null })) {
      return jsonError("You do not have permission to manage that employee.", 403);
    }
    return resultResponse(await archiveDirectPayTarget(operator.pool, id, operator.user.id));
  } catch (error) {
    return jsonError(redactError(error, "The direct-pay target could not be archived."), 500);
  }
}
