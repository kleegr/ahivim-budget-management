import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who am I. Returns 401 when there is no valid session. */
export async function GET() {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, user });
}
