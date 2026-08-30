import { NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { reviewCommittedDuplicateWarning } from "@/lib/manage/import-warnings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);
  const body = await readJson(request);
  if (body.action !== "mark_reviewed") return jsonError("Unknown action", 400);
  const reason = typeof body.reason === "string" && body.reason.trim()
    ? body.reason.trim()
    : null;
  try {
    const { id } = await params;
    return resultResponse(await reviewCommittedDuplicateWarning(getPool(), id, user.id, reason));
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
