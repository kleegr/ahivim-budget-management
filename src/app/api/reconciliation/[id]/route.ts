import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { candidatesForSession, manualMatch, unmatchSession } from "@/lib/manage/reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Candidate transactions for a scheduled session, so the UI can offer a match. Any role reads. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  const { id } = await params;
  try {
    const pool = getPool();
    return NextResponse.json({ ok: true, data: await candidatesForSession(pool, id) });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/**
 * Match a scheduled session to a transaction, or break an existing match.
 * `[id]` is the scheduled_session id. Manager or admin only.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = asString(body.reason) ?? null;

  try {
    const pool = getPool();
    if (body.action === "match") {
      const transactionId = asString(body.transactionId) ?? "";
      return resultResponse(await manualMatch(pool, id, transactionId, user.id, reason), 200);
    }
    if (body.action === "unmatch") {
      return resultResponse(await unmatchSession(pool, id, user.id, reason), 200);
    }
    return jsonError("Unknown action", 400);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
