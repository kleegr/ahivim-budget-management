import type { NextRequest } from "next/server";
import { getSettlementOperator } from "@/lib/auth/settlement-operator";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";
import { syncImportedPayrollCheckReviews } from "@/lib/manage/direct-pay-operations";
import {
  refreshSettlementObligations,
  settlementRefreshBlockingIssueMessage,
} from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Explicit repair for historical imports created before payroll-check reviews existed. */
export async function POST(request: NextRequest) {
  const operator = await getSettlementOperator();
  if (!operator) return jsonError("You do not have permission to repair imported checks.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  if (!operator.scope.allEmployees || !operator.scope.allIndividuals) {
    return jsonError("Historical check repair requires access to the full employee and individual roster.", 403);
  }
  if (!operator.scope.canSeeCheckGross || !operator.scope.canSeeCheckNet || !operator.scope.canSeeTaxes) {
    return jsonError("Historical check repair requires check-gross, check-net, and tax-detail access.", 403);
  }

  try {
    const data = await syncImportedPayrollCheckReviews(operator.pool, null, operator.user.id);
    if (data.checks === 0 && data.linkedTransactions === 0) {
      return Response.json({
        ok: true,
        data,
        settlements: null,
        settlementWarning: null,
        settlementRefreshSkipped: true,
      });
    }
    const settlementRefresh = await refreshSettlementObligations(operator.pool, {}, operator.user.id);
    const settlementWarning = settlementRefresh.ok
      ? settlementRefreshBlockingIssueMessage(settlementRefresh.data)
      : settlementRefresh.message;
    return Response.json({
      ok: true,
      data,
      settlements: settlementRefresh.ok ? settlementRefresh.data : null,
      settlementWarning,
      settlementRefreshSkipped: false,
    });
  } catch (error) {
    return jsonError(redactError(error, "Imported checks could not be reviewed."), 500);
  }
}
