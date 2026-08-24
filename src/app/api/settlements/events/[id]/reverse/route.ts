import { type NextRequest } from "next/server";
import { canOperateSettlementEvent, getSettlementOperator } from "@/lib/auth/settlement-operator";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { reverseSettlementEvent } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const operator = await getSettlementOperator();
  if (!operator) return jsonError("You do not have permission to reverse money activity.", 403);
  const { user, scope, pool } = operator;
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  const { id } = await params;
  try {
    if (!await canOperateSettlementEvent(pool, scope, id)) {
      return jsonError("You do not have permission to reverse that activity.", 403);
    }
    return resultResponse(await reverseSettlementEvent(
      pool,
      id,
      String(body.reason ?? ""),
      user.id,
      String(body.operationKey ?? ""),
    ));
  } catch (error) {
    return jsonError(redactError(error, "The settlement event could not be reversed."), 500);
  }
}
