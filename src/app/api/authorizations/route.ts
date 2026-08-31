import { NextRequest } from "next/server";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { createAuthorization, type AuthorizationInput } from "@/lib/manage/authorizations";
import {
  canCreateHourAuthorization,
  containsFinancialAuthorizationFields,
  getHourAuthorizationOperator,
  redactHourAuthorizationResult,
} from "@/lib/auth/hour-authorization-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create an authorization. Planners are restricted to hours-only programs. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const operator = await getHourAuthorizationOperator();
  if (!operator) return jsonError("Budget authorization access required", 403);

  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    let input = body as unknown as AuthorizationInput;
    if (operator.mode === "hours_only") {
      if (containsFinancialAuthorizationFields(body)) {
        return jsonError("Budget planners may change authorized hours only", 403);
      }
      if (!await canCreateHourAuthorization(
        operator.pool,
        operator.scope,
        String(body.budgetPeriodId ?? ""),
        String(body.programId ?? ""),
      )) {
        return jsonError("That hours authorization is not available", 404);
      }
      input = {
        budgetPeriodId: String(body.budgetPeriodId ?? ""),
        programId: String(body.programId ?? ""),
        authorizedHours:
          typeof body.authorizedHours === "string" || typeof body.authorizedHours === "number"
            ? body.authorizedHours
            : null,
        notes: typeof body.notes === "string" ? body.notes : null,
      };
    }
    const result = await createAuthorization(
      operator.pool,
      input,
      operator.user.id,
      reason,
    );
    return resultResponse(
      result.ok && operator.mode === "hours_only"
        ? { ...result, data: redactHourAuthorizationResult(result.data) }
        : result,
      201,
    );
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
