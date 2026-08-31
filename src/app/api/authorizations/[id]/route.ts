import { NextRequest } from "next/server";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import {
  cancelAuthorization,
  reviseAuthorization,
  type AuthorizationInput,
} from "@/lib/manage/authorizations";
import {
  canChangeHourAuthorization,
  containsFinancialAuthorizationFields,
  getHourAuthorizationOperator,
  redactHourAuthorizationResult,
} from "@/lib/auth/hour-authorization-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revise an authorization (supersedes the active revision), or cancel it when
 * `body.action` is "cancel". Planners are restricted to hours-only programs.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const operator = await getHourAuthorizationOperator();
  if (!operator) return jsonError("Budget authorization access required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const action = body.action;
  if (reason.length < 5) {
    return jsonError("Enter a change reason of at least 5 characters for the audit history.", 400);
  }

  try {
    let input = body as unknown as Partial<AuthorizationInput>;
    if (operator.mode === "hours_only") {
      if (containsFinancialAuthorizationFields(body)) {
        return jsonError("Budget planners may change authorized hours only", 403);
      }
      if (!await canChangeHourAuthorization(operator.pool, operator.scope, id)) {
        return jsonError("That hours authorization is not available", 404);
      }
      input = {
        ...(typeof body.authorizedHours === "string" || typeof body.authorizedHours === "number"
          ? { authorizedHours: body.authorizedHours }
          : {}),
        ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
      };
    }
    if (action === "cancel") {
      const result = await cancelAuthorization(operator.pool, id, operator.user.id, reason);
      return resultResponse(
        result.ok && operator.mode === "hours_only"
          ? { ...result, data: redactHourAuthorizationResult(result.data) }
          : result,
        200,
      );
    }
    const result = await reviseAuthorization(
      operator.pool,
      id,
      input,
      operator.user.id,
      reason,
    );
    return resultResponse(
      result.ok && operator.mode === "hours_only"
        ? { ...result, data: redactHourAuthorizationResult(result.data) }
        : result,
      200,
    );
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
