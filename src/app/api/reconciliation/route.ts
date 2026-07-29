import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { autoReconcile } from "@/lib/manage/reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Auto-reconcile a date range: link the obvious single-individual sessions to
 * their one matching transaction. Manager or admin only.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const body = await readJson(request);
  if (body.action !== "auto") return jsonError("Unknown action", 400);

  const from = asString(body.from);
  const to = asString(body.to);
  if (!from || !to) return jsonError("A from and to date are required.", 400);
  const programId = asString(body.programId); // undefined → all programs

  try {
    const pool = getPool();
    const result = await autoReconcile(pool, { from, to, programId }, user.id);
    return resultResponse(result, 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
