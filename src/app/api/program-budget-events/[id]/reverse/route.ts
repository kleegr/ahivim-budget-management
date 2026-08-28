import { NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { reverseProgramBudgetEvent } from "@/lib/manage/program-budgets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : "";
  try {
    const { id } = await params;
    return resultResponse(await reverseProgramBudgetEvent(getPool(), id, user.id, reason), 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
