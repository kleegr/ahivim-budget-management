import { NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { listProgramBudgets } from "@/lib/data/program-budgets";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { createProgramBudget, type CreateProgramBudgetInput } from "@/lib/manage/program-budgets";

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
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;
  try {
    const result = await createProgramBudget(
      getPool(),
      body as unknown as CreateProgramBudgetInput,
      user.id,
      reason,
    );
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
