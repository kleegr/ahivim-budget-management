import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import {
  cancelAuthorization,
  reviseAuthorization,
  type AuthorizationInput,
} from "@/lib/manage/authorizations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revise an authorization (supersedes the active revision), or cancel it when
 * `body.action` is "cancel". Manager or admin only.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;
  const action = body.action;

  try {
    const pool = getPool();
    if (action === "cancel") {
      const result = await cancelAuthorization(pool, id, user.id, reason);
      return resultResponse(result, 200);
    }
    const result = await reviseAuthorization(
      pool,
      id,
      body as unknown as Partial<AuthorizationInput>,
      user.id,
      reason,
    );
    return resultResponse(result, 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
