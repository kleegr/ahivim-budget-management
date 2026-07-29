import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { cancelSeries } from "@/lib/manage/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Mutate a series. `action = cancel` cancels the series and every still-pending
 * occurrence (completed sessions are left untouched). Manager or admin only.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const action = asString(body.action);
  const reason = asString(body.reason) ?? null;

  try {
    const pool = getPool();
    if (action === "cancel") {
      return resultResponse(await cancelSeries(pool, id, user.id, reason), 200);
    }
    return jsonError("Unknown action.", 400);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
