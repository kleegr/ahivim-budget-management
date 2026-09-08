import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { recoverSourceNet } from "@/lib/sheets/net-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  const user = await apiUser("manager");
  if (!user) return jsonError("You need the manager role to review recovered source NET.", 403);
  const { id } = await params;
  const body = await readJson(request);
  if (body?.action !== "accept" && body?.action !== "undo") return jsonError("Choose accept or undo.", 400);
  try {
    return resultResponse(await recoverSourceNet(getPool(), id, {
      action: body.action,
      reason: typeof body.reason === "string" ? body.reason : "",
      operationKey: typeof body.operationKey === "string" ? body.operationKey : "",
      acceptanceAuditId: typeof body.acceptanceAuditId === "string" ? body.acceptanceAuditId : undefined,
    }, user.actorId));
  } catch (error) {
    return jsonError(redactError(error, "The source NET recovery could not be saved."), 500);
  }
}
