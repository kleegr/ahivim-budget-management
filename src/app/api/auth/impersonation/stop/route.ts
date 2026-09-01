import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  clearAuthenticationCookies,
  currentImpersonationSession,
  currentSession,
  restoreOwnerSession,
} from "@/lib/auth/session";
import { findUserById, writeAudit } from "@/lib/auth/users";
import { jsonError, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** End view-as and restore the original, still-authorized owner session. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const wantsJson = (request.headers.get("content-type") ?? "").includes("application/json");
  const [session, impersonation] = await Promise.all([
    currentSession(),
    currentImpersonationSession(),
  ]);
  if (
    !session
    || !impersonation
    || session.userId !== impersonation.targetUserId
    || session.impersonatorUserId !== impersonation.ownerUserId
  ) {
    await clearAuthenticationCookies();
    return failedReturn(request, wantsJson, "The owner session could not be verified.", 401);
  }

  const pool = getPool();
  const owner = await findUserById(pool, impersonation.ownerUserId).catch(() => null);
  if (!owner || !owner.isActive || owner.role !== "admin") {
    await clearAuthenticationCookies();
    return failedReturn(
      request,
      wantsJson,
      "The owner account no longer has permission to return.",
      403,
    );
  }

  try {
    await writeAudit(pool, {
      userId: owner.id,
      action: "user_impersonation_stopped",
      entityType: "user",
      entityId: impersonation.targetUserId,
    });
  } catch {
    return failedReturn(
      request,
      wantsJson,
      "The return could not be recorded. You are still viewing this user.",
      503,
      true,
    );
  }

  const restored = await restoreOwnerSession(owner, impersonation).catch(() => false);
  if (!restored) {
    await clearAuthenticationCookies();
    return failedReturn(request, wantsJson, "The owner session has expired.", 401);
  }

  if (wantsJson) {
    return NextResponse.json({ ok: true, redirectTo: "/home" });
  }
  return NextResponse.redirect(new URL("/home", request.nextUrl.origin), { status: 303 });
}

function failedReturn(
  request: NextRequest,
  wantsJson: boolean,
  message: string,
  status: number,
  keepPreview = false,
) {
  if (wantsJson) return jsonError(message, status);
  if (keepPreview) {
    const referer = request.headers.get("referer");
    const destination = new URL("/home", request.nextUrl.origin);
    if (referer) {
      try {
        const candidate = new URL(referer);
        if (candidate.origin === request.nextUrl.origin) {
          destination.pathname = candidate.pathname;
          destination.search = candidate.search;
        }
      } catch {
        // Use the role's normal home route when the referrer is invalid.
      }
    }
    destination.searchParams.set("previewError", message);
    return NextResponse.redirect(destination, { status: 303 });
  }
  const signin = new URL("/signin", request.nextUrl.origin);
  signin.searchParams.set("error", message);
  return NextResponse.redirect(signin, { status: 303 });
}
