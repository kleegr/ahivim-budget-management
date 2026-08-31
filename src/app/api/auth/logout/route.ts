import { NextRequest, NextResponse } from "next/server";
import {
  clearAuthenticationCookies,
  currentImpersonationSession,
  currentSession,
} from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { writeAudit } from "@/lib/auth/users";
import { sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign out. POST only, so a cross-site image or link cannot trigger it. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const [session, impersonation] = await Promise.all([
    currentSession(),
    currentImpersonationSession(),
  ]);
  await clearAuthenticationCookies();

  if (session) {
    await writeAudit(getPool(), {
      userId: session.userId,
      action: "logout",
      entityType: "user",
      entityId: session.userId,
    }).catch(() => undefined);
  }
  if (
    session
    && impersonation?.targetUserId === session.userId
    && session.impersonatorUserId === impersonation.ownerUserId
  ) {
    await writeAudit(getPool(), {
      userId: impersonation.ownerUserId,
      action: "user_impersonation_ended_by_logout",
      entityType: "user",
      entityId: impersonation.targetUserId,
    }).catch(() => undefined);
  }

  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.redirect(new URL("/signin", request.nextUrl.origin), { status: 303 });
}
