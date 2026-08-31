import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import type { PgLikePool } from "@/lib/import/commit";
import { ensureMigrationsApplied } from "@/lib/db/auto-migrate";
import { getSetting, setSetting } from "@/lib/manage/app-settings";
import { getSyncConfig } from "@/lib/sheets/config";
import { runSheetSync } from "@/lib/sheets/sync";
import { currentUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BOOTSTRAP_FLAG = "initial_sheet_sync_done";

/** The most recent run and the live ledger totals, for deploy verification. */
async function verification(pool: PgLikePool) {
  const { rows: runRows } = await pool.query(
    `SELECT trigger, status, source_rows, rows_added, rows_updated, rows_skipped,
            rows_flagged, rows_failed, reconciliation, error_message,
            started_at::text AS started_at, finished_at::text AS finished_at
       FROM sheet_sync_runs ORDER BY started_at DESC LIMIT 1`,
  );
  const { rows: totalRows } = await pool.query<{ txns: string; gross: string; internal: string }>(
    `SELECT count(*)::text AS txns,
            COALESCE(sum(imported_amount), 0)::text AS gross,
            COALESCE(sum(calculated_internal_amount), 0)::text AS internal
       FROM payroll_transactions`,
  );
  return { latestRun: runRows[0] ?? null, ledger: totalRows[0] ?? null };
}

/**
 * One-time initial sync bootstrap.
 *
 * Runs the very first full sync of the Google Sheet on a deployed instance,
 * exactly once, then becomes inert. It is intentionally reachable without the
 * cron secret — the same self-service pattern as GET /api/health/schema, which
 * applies migrations for any caller — because the only thing it can do is run a
 * single sheet sync: idempotent, non-destructive (it never deletes or
 * overwrites), and a no-op after the first success. The recurring scheduled
 * sync is a separate endpoint that stays secured by CRON_SECRET.
 */
export async function GET() {
  const pool = getPool();
  let isAdmin = false;
  try {
    isAdmin = (await currentUser())?.role === "admin";
  } catch {
    isAdmin = false;
  }

  // The bootstrap may be the first request after the deploy that shipped 0011.
  try {
    await ensureMigrationsApplied();
  } catch {
    /* the sync will surface a clear error if the schema is not ready */
  }

  const done = await getSetting<boolean>(pool, BOOTSTRAP_FLAG);
  if (done) {
    return NextResponse.json({
      ok: true,
      alreadyDone: true,
      note: "The initial sync has already run.",
      ...(isAdmin ? await verification(pool) : {}),
    });
  }

  const config = await getSyncConfig(pool);
  const summary = await runSheetSync(pool, { trigger: "initial", userId: null, config });

  if (summary.status !== "failed") {
    await setSetting(pool, BOOTSTRAP_FLAG, true, null);
  }

  return NextResponse.json({
    ok: summary.status !== "failed",
    status: summary.status,
    ...(isAdmin ? { summary, ...(await verification(pool)) } : {}),
  });
}
