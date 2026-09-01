import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  apiUser,
  clearAuthenticationCookies,
  createImpersonationSession,
  currentImpersonationSession,
  currentSession,
  restoreOwnerSession,
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
  if (!actor) return failedStart(request, wantsJson, "Administrator access required", 403);

  // An administrator target may itself have admin authority, so this explicit
  // proof check is what prevents a view-as session from being nested.
  if (await currentImpersonationSession()) {
    return failedStart(
      request,
      wantsJson,
      "Return to your own portal before viewing another user.",
      409,
    );
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
    return failedStart(request, wantsJson, "Choose another active user to preview.", 400);
  }

  const ownerSession = await currentSession();
  if (
    !ownerSession
    || ownerSession.userId !== actor.id
    || ownerSession.impersonatorUserId
  ) {
    return failedStart(
      request,
      wantsJson,
      "Your session could not be verified. Sign in again.",
      401,
    );
  }

  const pool = getPool();
  const target = await findUserById(pool, targetUserId).catch(() => null);
  if (!target || !target.isActive) {
    return failedStart(
      request,
      wantsJson,
      "That user is not available to preview.",
      404,
    );
  }

  let proof: Awaited<ReturnType<typeof createImpersonationSession>>;
  try {
    proof = await createImpersonationSession(actor, target, ownerSession.exp);
  } catch {
    await clearAuthenticationCookies().catch(() => undefined);
    return failedStart(
      request,
      wantsJson,
      "The user preview could not be started. Sign in and try again.",
      503,
    );
  }

  try {
    await writeAudit(pool, {
      userId: actor.id,
      action: "user_impersonation_started",
      entityType: "user",
      entityId: target.id,
      metadata: { targetRole: target.role },
    });
  } catch {
    const restored = await restoreOwnerSession(actor, proof).catch(() => false);
    if (!restored) await clearAuthenticationCookies().catch(() => undefined);
    return failedStart(
      request,
      wantsJson,
      "The user preview could not be recorded, so it was not opened. Try again.",
      503,
    );
  }

  if (wantsJson) {
    return NextResponse.json({ ok: true, redirectTo: "/home" });
  }
  return NextResponse.redirect(new URL("/home", request.nextUrl.origin), { status: 303 });
}

function failedStart(
  request: NextRequest,
  wantsJson: boolean,
  message: string,
  status: number,
) {
  if (wantsJson) return jsonError(message, status);
  const settings = new URL("/settings", request.nextUrl.origin);
  settings.searchParams.set("previewError", message);
  settings.hash = "access";
  return NextResponse.redirect(settings, { status: 303 });
}
