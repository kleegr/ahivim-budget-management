import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import {
  setSessionStatus,
  rescheduleSession,
  duplicateSession,
} from "@/lib/manage/schedule";
import { getSession } from "@/lib/data/schedule-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const SESSION_STATUSES = ["pending", "completed", "cancelled", "no_show"] as const;
type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Read one planned session. Any signed-in role. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  try {
    const pool = getPool();
    const record = await getSession(pool, id);
    if (!record) return jsonError("Not found", 404);
    return NextResponse.json({ ok: true, data: record });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/**
 * Mutate one session. `action` selects the operation:
 *   status     — set completed / cancelled / no_show / pending
 *   cancel     — shorthand for status = cancelled
 *   reschedule — move date and/or times (re-runs conflict detection)
 *   duplicate  — copy the session onto another date
 * Manager or admin only.
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
      return resultResponse(await setSessionStatus(pool, id, "cancelled", user.id, reason), 200);
    }

    if (action === "status") {
      const status = asString(body.status);
      if (!status || !SESSION_STATUSES.includes(status as SessionStatus)) {
        return jsonError("Provide a valid status.", 400);
      }
      return resultResponse(await setSessionStatus(pool, id, status as SessionStatus, user.id, reason), 200);
    }

    if (action === "reschedule") {
      return resultResponse(
        await rescheduleSession(
          pool,
          id,
          {
            sessionDate: asString(body.sessionDate),
            startTime: body.startTime === undefined ? undefined : (asString(body.startTime) ?? null),
            endTime: body.endTime === undefined ? undefined : (asString(body.endTime) ?? null),
          },
          user.id,
          reason,
        ),
        200,
      );
    }

    if (action === "duplicate") {
      const toDate = asString(body.toDate) ?? asString(body.sessionDate);
      if (!toDate) return jsonError("Provide the date to duplicate onto.", 400);
      return resultResponse(await duplicateSession(pool, id, toDate, user.id, reason), 201);
    }

    return jsonError("Unknown action.", 400);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
