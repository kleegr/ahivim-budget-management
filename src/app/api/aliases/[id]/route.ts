import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { setAliasStatus, rematchAlias, type AliasKind } from "@/lib/manage/aliases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Change an alias. Requires `body.kind` ("individual" | "employee"). A
 * `body.action` of approve / reject / archive / pending sets its status, while
 * "rematch" points it at `body.canonicalId`. Manager or admin only.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;
  const kind = body.kind as AliasKind;
  const action = body.action;

  try {
    const pool = getPool();
    if (action === "rematch") {
      const result = await rematchAlias(pool, kind, id, body.canonicalId as string, user.id, reason);
      return resultResponse(result, 200);
    }
    if (action === "approve" || action === "reject" || action === "archive" || action === "pending") {
      const status: "approved" | "rejected" | "archived" | "pending" =
        action === "approve"
          ? "approved"
          : action === "reject"
            ? "rejected"
            : action === "archive"
              ? "archived"
              : "pending";
      const result = await setAliasStatus(pool, kind, id, status, user.id, reason);
      return resultResponse(result, 200);
    }
    return jsonError("Unknown action", 400);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
