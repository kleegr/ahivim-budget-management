import { NextRequest, NextResponse } from "next/server";
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
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. When CRON_SECRET
 * is set the header must match (a signed-in admin may also trigger it), so the
 * endpoint is locked down. When CRON_SECRET is NOT set the endpoint is open, so
 * the scheduled sync works out of the box — this is safe because the only thing
 * an unauthenticated call can do is run a sheet sync, which is idempotent,
 * rate-limited by the min-interval guard, non-destructive (it never deletes or
 * overwrites), and returns only counts. Setting CRON_SECRET hardens it.
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
async function authorize(request: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  // No secret configured → open (see the security note above). Once a secret is
  // set, a matching Bearer/key or a signed-in admin is required.
  if (!secret) return true;
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const key = bearer ?? request.nextUrl.searchParams.get("key");
  if (key === secret) return true;
  const user = await apiUser("admin");
  return Boolean(user);
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
  if (!(await authorize(request))) return jsonError("Unauthorized", 401);

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

  const summary = await runSheetSync(pool, { trigger: "scheduled", userId: null, config });
  return NextResponse.json({ ok: summary.status !== "failed", ran: true, summary });
}

/** Allow a POST trigger too (some cron setups POST). Same behaviour. */
export async function POST(request: NextRequest) {
  return GET(request);
}
