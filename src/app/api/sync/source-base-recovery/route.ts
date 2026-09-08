import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { recoverSourceBase } from "@/lib/sheets/base-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  const user = await apiUser("manager");
  if (!user) return jsonError("You need the manager role to review source-based amounts.",403);
  const body = await readJson(request);
  if (body?.action !== "accept" && body?.action !== "undo") return jsonError("Choose accept or undo.",400);
  if (body.transactionIds !== undefined && (!Array.isArray(body.transactionIds) || body.transactionIds.some(id => typeof id !== "string"))) {
    return jsonError("Choose recorded transactions from the review.",400);
  }
  try {
    return resultResponse(await recoverSourceBase(getPool(),{
      action:body.action,reason:typeof body.reason === "string" ? body.reason : "",
      operationKey:typeof body.operationKey === "string" ? body.operationKey : "",sourceHash:typeof body.sourceHash === "string" ? body.sourceHash : "",
      transactionIds:body.transactionIds as string[] | undefined,
      acceptanceAuditId:typeof body.acceptanceAuditId === "string" ? body.acceptanceAuditId : undefined,
    },user.actorId));
  } catch(error) { return jsonError(redactError(error,"The source-base repair could not be saved."),500); }
}
