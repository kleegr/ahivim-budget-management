import { getPool } from "./index";
import { getSetting, setSetting } from "@/lib/manage/app-settings";
import { scanMatches } from "@/lib/manage/individual-merge";

/**
 * One-time data tasks that run after migrations on a deployed instance, so the
 * production database self-heals without an operator POSTing anywhere.
 *
 * Currently: the first match scan. It queues possible spelling variants from
 * the two workbook tabs for human review and never merges people itself.
 * Guarded by an app_settings flag so it runs once, and the scan itself is
 * idempotent (existing review pairs are remembered).
 */
let started = false;

export async function ensurePostMigrationTasks(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const pool = getPool();
    const flag = await getSetting<boolean>(pool, "match_scan_v2_done");
    if (flag) return;
    // Clear any queue from an earlier, looser scan (undecided rows only — a human's
    // confirm/reject is preserved), then re-scan with the current, tighter rules.
    await pool.query(`DELETE FROM individual_match_reviews WHERE status = 'pending'`).catch(() => {});
    const res = await scanMatches(pool, null);
    if (res.ok) {
      await setSetting(pool, "match_scan_v2_done", true, null);
      console.log(`[post-migrate] match scan v2: merged=${res.data.merged} queued=${res.data.queued}`);
    }
  } catch (error) {
    // Never let a maintenance task affect the request; retried on a later boot.
    console.error("[post-migrate] task failed:", error instanceof Error ? error.message : "unknown");
  }
}
