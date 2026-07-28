import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, currentSession } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { writeAudit } from "@/lib/auth/users";
import { sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign out. POST only, so a cross-site image or link cannot trigger it. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const session = await currentSession();
  await clearSessionCookie();

  if (session) {
    await writeAudit(getPool(), {
      userId: session.userId,
      action: "logout",
      entityType: "user",
      entityId: session.userId,
    }).catch(() => undefined);
  }

  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.redirect(new URL("/signin", request.nextUrl.origin), { status: 303 });
}
