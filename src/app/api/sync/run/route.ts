import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";
import { runSheetSync } from "@/lib/sheets/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * "Sync now". Manager or admin. Runs the sheet sync immediately (trigger =
 * manual) and returns the run summary. A failed sync is reported as a domain
 * outcome (ok:false) with the recorded error, not an HTTP 500, so the UI can
 * show it and offer a retry.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("You need the manager role to run a sync.", 403);

  try {
    const summary = await runSheetSync(getPool(), { trigger: "manual", userId: user.id });
    return NextResponse.json({ ok: summary.status !== "failed", summary });
  } catch (error) {
    return jsonError(redactError(error, "The sync could not be run."), 500);
  }
}
