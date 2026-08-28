import { NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { listProgramBudgetEvents } from "@/lib/data/program-budgets";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import {
  createProgramBudgetEvent,
  type CreateProgramBudgetEventInput,
} from "@/lib/manage/program-budgets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);
  const params = request.nextUrl.searchParams;
  try {
    const data = await listProgramBudgetEvents(
      getPool(),
      params.get("budgetPeriodId") ?? "",
      params.get("programId") ?? "",
    );
    return Response.json({ ok: true, data });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);
  const body = await readJson(request);
  try {
    const result = await createProgramBudgetEvent(
      getPool(),
      body as unknown as CreateProgramBudgetEventInput,
      user.id,
    );
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
