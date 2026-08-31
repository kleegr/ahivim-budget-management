import { NextRequest } from "next/server";
import {
  canChangeHourBudgetPeriod,
  getHourAuthorizationOperator,
} from "@/lib/auth/hour-authorization-access";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { updateBudgetPeriodRenewal } from "@/lib/manage/authorizations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const operator = await getHourAuthorizationOperator();
  if (!operator) return jsonError("Budget authorization access required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const renewalDate = typeof body.renewalDate === "string" ? body.renewalDate.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!renewalDate) return jsonError("Enter the renewal date.", 400);
  if (reason.length < 5) {
    return jsonError("Enter a change reason of at least 5 characters for the audit history.", 400);
  }

  try {
    if (operator.mode === "hours_only" && !await canChangeHourBudgetPeriod(
      operator.pool,
      operator.scope,
      id,
    )) {
      return jsonError("That hours authorization period is not available", 404);
    }
    const result = await updateBudgetPeriodRenewal(
      operator.pool,
      id,
      renewalDate,
      operator.user.id,
      reason,
    );
    return resultResponse(result, 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
