import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  apiUser,
  createImpersonationSession,
  currentImpersonationSession,
  currentSession,
} from "@/lib/auth/session";
import { findUserById, writeAudit } from "@/lib/auth/users";
import { jsonError, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start a real server-authorized view of another active user's portal. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const wantsJson = (request.headers.get("content-type") ?? "").includes("application/json");
  const actor = await apiUser("admin");
  if (!actor) return jsonError("Administrator access required", 403);

  // An administrator target may itself have admin authority, so this explicit
  // proof check is what prevents a view-as session from being nested.
  if (await currentImpersonationSession()) {
    return jsonError("Return to your own portal before viewing another user.", 409);
  }

  let targetUserId = "";
  if (wantsJson) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    targetUserId = typeof body.targetUserId === "string" ? body.targetUserId : "";
  } else {
    const form = await request.formData();
    targetUserId = String(form.get("targetUserId") ?? "");
  }

  if (!targetUserId || targetUserId === actor.id) {
    return jsonError("Choose another active user to preview.", 400);
  }

  const ownerSession = await currentSession();
  if (
    !ownerSession
    || ownerSession.userId !== actor.id
    || ownerSession.impersonatorUserId
  ) {
    return jsonError("Your session could not be verified. Sign in again.", 401);
  }

  const pool = getPool();
  const target = await findUserById(pool, targetUserId).catch(() => null);
  if (!target || !target.isActive) {
    return jsonError("That user is not available to preview.", 404);
  }

  try {
    await writeAudit(pool, {
      userId: actor.id,
      action: "user_impersonation_started",
      entityType: "user",
      entityId: target.id,
      metadata: { targetRole: target.role },
    });
    await createImpersonationSession(actor, target, ownerSession.exp);
  } catch {
    return jsonError("The user preview could not be started. Try again.", 503);
  }

  if (wantsJson) {
    return NextResponse.json({ ok: true, redirectTo: "/home" });
  }
  return NextResponse.redirect(new URL("/home", request.nextUrl.origin), { status: 303 });
}
