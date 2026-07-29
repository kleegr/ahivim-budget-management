import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { setGroupStatus } from "@/lib/manage/group-detection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** action → the group_detection_status it writes. */
const STATUS_FOR_ACTION: Record<string, string> = {
  confirm: "confirmed",
  reject: "single",
  review: "needs_review",
};

/**
 * Confirm, reject, or send back for review a detected group. `[id]` is the
 * service_session id. Manager or admin only. The allocations are never
 * touched — only the detection status moves — and the change is audited.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const action = asString(body.action) ?? "";
  const status = STATUS_FOR_ACTION[action];
  if (!status) return jsonError("Unknown action", 400);
  const reason = asString(body.reason) ?? null;

  try {
    const pool = getPool();
    return resultResponse(await setGroupStatus(pool, id, status, user.id, reason), 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
