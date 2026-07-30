import { type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError } from "@/lib/http";
import { decideMatchReview } from "@/lib/manage/individual-merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to decide matches.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  const body = await readJson(request);
  const decision = body.action === "confirm" ? "confirm" : body.action === "reject" ? "reject" : null;
  if (!decision) return jsonError("Choose confirm or reject.", 400);
  const reason = typeof body.reason === "string" ? body.reason : null;
  // Optional swap of survivor direction from the UI.
  const keepId = typeof body.keepId === "string" ? body.keepId : undefined;
  const mergeId = typeof body.mergeId === "string" ? body.mergeId : undefined;
  const result = await decideMatchReview(getPool(), { id, decision, keepId, mergeId }, user.id, reason);
  return resultResponse(result);
}
