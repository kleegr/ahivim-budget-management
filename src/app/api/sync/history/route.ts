import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";
import { clearSyncHistory } from "@/lib/sheets/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Clear the sync run history. Admin only. Tracking rows and open conflicts are kept. */
export async function DELETE(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("admin");
  if (!user) return jsonError("You need the administrator role to clear sync history.", 403);

  try {
    const deleted = await clearSyncHistory(getPool(), user.id);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return jsonError(redactError(error, "Could not clear the sync history."), 500);
  }
}
