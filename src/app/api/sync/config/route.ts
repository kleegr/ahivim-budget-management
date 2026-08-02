import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { jsonError, readJson, redactError, sameOriginOrFail } from "@/lib/http";
import { getSyncConfig, setSyncConfig } from "@/lib/sheets/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read the current sync configuration. Any manager may read it. */
export async function GET() {
  const user = await apiUser("manager");
  if (!user) return jsonError("Authentication required", 401);
  try {
    return NextResponse.json({ ok: true, config: await getSyncConfig(getPool()) });
  } catch (error) {
    return jsonError(redactError(error, "Could not read the sync configuration."), 500);
  }
}

/** Update the sync configuration (enable/disable, sheet id/tab, schedule hour). Admin only. */
export async function PUT(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("admin");
  if (!user) return jsonError("You need the administrator role to change sync settings.", 403);

  const body = await readJson(request);
  const patch: Record<string, unknown> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.sheetId === "string") patch.sheetId = body.sheetId;
  if (typeof body.sheetName === "string") patch.sheetName = body.sheetName;
  if (body.scheduleHourUtc !== undefined) patch.scheduleHourUtc = Number(body.scheduleHourUtc);
  if (body.minIntervalMinutes !== undefined) patch.minIntervalMinutes = Number(body.minIntervalMinutes);

  try {
    const config = await setSyncConfig(getPool(), patch, user.id);
    return NextResponse.json({ ok: true, config });
  } catch (error) {
    return jsonError(redactError(error, "Could not update the sync configuration."), 500);
  }
}
