import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/http";
import { ensureMigrationsApplied } from "@/lib/db/auto-migrate";
import { getSyncConfig } from "@/lib/sheets/config";
import { runSheetSync } from "@/lib/sheets/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The scheduled sync endpoint hit by Vercel Cron.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. The configured
 * secret must match, or a signed-in administrator must authorize the request.
 * A missing secret never makes this database-writing route public.
 *
 * Self-gating makes the schedule configurable without a redeploy:
 *   • disabled              → skip.
 *   • synced very recently  → skip (min-interval guard; stops double runs).
 *   • outside the hour       → skip, UNLESS a day has nearly passed since the
 *                              last success (a daily-cron safety net so a sync
 *                              still happens even if the ping hour differs).
 * So the effective run time follows the configured hour when the cron pings
 * often enough, and still guarantees a daily sync on a once-a-day cron.
 */
async function authorize(request: NextRequest): Promise<{
  authorisedBy: "cron_secret" | "admin_session";
  actorId: string | null;
} | null> {
  const secret = process.env.CRON_SECRET?.trim();
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (secret && bearer && safeEqual(secret, bearer)) {
    return { authorisedBy: "cron_secret", actorId: null };
  }
  const user = await apiUser("admin").catch(() => null);
  if (user) return { authorisedBy: "admin_session", actorId: user.actorId };
  return null;
}

async function lastSuccessAt(): Promise<Date | null> {
  const { rows } = await getPool().query<{ finished_at: string | null }>(
    `SELECT finished_at FROM sheet_sync_runs WHERE status = 'success'
      ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
  );
  const v = rows[0]?.finished_at;
  return v ? new Date(v) : null;
}

export async function GET(request: NextRequest) {
  const authorization = await authorize(request);
  if (!authorization) return jsonError("Unauthorized", 401);

  // The cron may be the first request after a deploy that shipped a migration.
  try {
    await ensureMigrationsApplied();
  } catch {
    /* never let a migration attempt fail the scheduled run outright */
  }

  const pool = getPool();
  const config = await getSyncConfig(pool);
  if (!config.enabled) {
    return NextResponse.json({ ok: true, ran: false, reason: "disabled" });
  }

  const last = await lastSuccessAt();
  const now = new Date();
  const minutesSince = last ? (now.getTime() - last.getTime()) / 60000 : Infinity;
  if (minutesSince < config.minIntervalMinutes) {
    return NextResponse.json({ ok: true, ran: false, reason: "recently_synced", minutesSince: Math.round(minutesSince) });
  }
  const hourMatch = now.getUTCHours() === config.scheduleHourUtc;
  const dailyFallback = minutesSince >= 23 * 60;
  if (!hourMatch && !dailyFallback) {
    return NextResponse.json({
      ok: true,
      ran: false,
      reason: "outside_window",
      utcHour: now.getUTCHours(),
      scheduleHourUtc: config.scheduleHourUtc,
    });
  }

  const summary = await runSheetSync(pool, {
    trigger: "scheduled",
    userId: authorization.actorId,
    config,
  });
  return NextResponse.json({
    ok: summary.status !== "failed",
    ran: true,
    status: summary.status,
    authorisedBy: authorization.authorisedBy,
    summary,
  });
}

/** Allow a POST trigger too (some cron setups POST). Same behaviour. */
export async function POST(request: NextRequest) {
  return GET(request);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
