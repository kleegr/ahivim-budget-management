import type { NextRequest } from "next/server";
import { canOperateSettlementPerson, getSettlementOperator } from "@/lib/auth/settlement-operator";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { savePayrollCheck } from "@/lib/manage/direct-pay-operations";
import { refreshSettlementObligations } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const operator = await getSettlementOperator();
  if (!operator) return jsonError("You do not have permission to manage payroll checks.", 403);
  if (!operator.scope.canSeeCheckGross || !operator.scope.canSeeCheckNet || !operator.scope.canSeeTaxes) {
    return jsonError("Payroll-check editing requires check-gross, check-net, and tax-detail access.", 403);
  }
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  const employeeId = String(body.employeeId ?? "");
  if (!canOperateSettlementPerson(operator.scope, { employeeId, individualId: null })) {
    return jsonError("You do not have permission to manage that employee.", 403);
  }
  try {
    const result = await savePayrollCheck(operator.pool, {
      id: body.id ? String(body.id) : null,
      employeeId,
      checkNumber: body.checkNumber ? String(body.checkNumber) : null,
      checkDate: body.checkDate ? String(body.checkDate) : null,
      periodBegin: body.periodBegin ? String(body.periodBegin) : null,
      periodEnd: body.periodEnd ? String(body.periodEnd) : null,
      actualGross: body.actualGross == null ? null : String(body.actualGross),
      actualNet: String(body.actualNet ?? ""),
      taxWithheld: body.taxWithheld == null ? null : String(body.taxWithheld),
      sourceRef: body.sourceRef ? String(body.sourceRef) : null,
      verificationStatus: String(body.verificationStatus ?? "verified") as "unverified" | "verified" | "void",
      notes: body.notes ? String(body.notes) : null,
      sourceTransactionIds: Array.isArray(body.sourceTransactionIds)
        ? body.sourceTransactionIds.map(String)
        : body.sourceTransactionIds == null
          ? []
          : [String(body.sourceTransactionIds)],
    }, operator.user.id);
    if (!result.ok) return resultResponse(result);
    const settlementRefresh = await refreshSettlementObligations(operator.pool, { employeeId }, operator.user.id);
    return Response.json({
      ok: true,
      data: result.data,
      settlements: settlementRefresh.ok ? settlementRefresh.data : null,
      settlementWarning: settlementRefresh.ok ? null : settlementRefresh.message,
    }, { status: body.id ? 200 : 201 });
  } catch (error) {
    return jsonError(redactError(error, "The payroll check could not be saved."), 500);
  }
}
