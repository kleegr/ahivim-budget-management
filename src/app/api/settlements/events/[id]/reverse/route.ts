import { type NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { reverseSettlementEvent } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to reverse settlements.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  const { id } = await params;
  try {
    return resultResponse(await reverseSettlementEvent(
      getPool(),
      id,
      String(body.reason ?? ""),
      user.id,
      String(body.operationKey ?? ""),
    ));
  } catch (error) {
    return jsonError(redactError(error, "The settlement event could not be reversed."), 500);
  }
}
