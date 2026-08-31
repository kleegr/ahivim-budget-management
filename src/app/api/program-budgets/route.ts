import { NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { listProgramBudgets } from "@/lib/data/program-budgets";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { createProgramBudget, type CreateProgramBudgetInput } from "@/lib/manage/program-budgets";
import {
  canCreateHourProgramBudget,
  containsFinancialAuthorizationFields,
  getHourAuthorizationOperator,
  redactHourAuthorizationResult,
} from "@/lib/auth/hour-authorization-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);
  const params = request.nextUrl.searchParams;
  try {
    const data = await listProgramBudgets(getPool(), {
      individualId: params.get("individualId"),
      programId: params.get("programId"),
      status: params.get("status") === "active" || params.get("status") === "closed"
        ? params.get("status") as "active" | "closed"
        : null,
      asOf: params.get("asOf"),
    });
    return Response.json({ ok: true, data });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  const operator = await getHourAuthorizationOperator();
  if (!operator) return jsonError("Budget authorization access required", 403);
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;
  try {
    let input = body as unknown as CreateProgramBudgetInput;
    if (operator.mode === "hours_only") {
      if (containsFinancialAuthorizationFields(body)) {
        return jsonError("Budget planners may create hours-only authorizations", 403);
      }
      if (!await canCreateHourProgramBudget(
        operator.pool,
        operator.scope,
        String(body.individualId ?? ""),
        String(body.programId ?? ""),
      )) {
        return jsonError("That hours program is not available", 404);
      }
      // Keep the planner write surface intentionally small even when a caller
      // submits extra JSON fields that the current form does not expose.
      input = {
        individualId: String(body.individualId ?? ""),
        programId: String(body.programId ?? ""),
        label: typeof body.label === "string" ? body.label : null,
        startDate: typeof body.startDate === "string" ? body.startDate : null,
        endDate: typeof body.endDate === "string" ? body.endDate : null,
        periodType: typeof body.periodType === "string" ? body.periodType : null,
        year: typeof body.year === "string" || typeof body.year === "number" ? body.year : null,
        renewalDate: typeof body.renewalDate === "string" ? body.renewalDate : null,
        authorizedHours:
          typeof body.authorizedHours === "string" || typeof body.authorizedHours === "number"
            ? body.authorizedHours
            : null,
        notes: typeof body.notes === "string" ? body.notes : null,
      };
    }
    const result = await createProgramBudget(
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
