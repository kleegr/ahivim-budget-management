import { getPool } from "./index";
import { getSetting, setSetting } from "@/lib/manage/app-settings";
import { scanMatches } from "@/lib/manage/individual-merge";

/**
 * One-time data tasks that run after migrations on a deployed instance, so the
 * production database self-heals without an operator POSTing anywhere.
 *
 * Currently: the first match scan. It connects the obvious spelling variants
 * the two workbook tabs created (auto-merging clear typos, queuing uncertain
 * pairs for review). Guarded by an app_settings flag so it runs once, and the
 * scan itself is idempotent (rejected pairs are remembered, merged rows skipped).
 */
let started = false;

export async function ensurePostMigrationTasks(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const pool = getPool();
    const flag = await getSetting<boolean>(pool, "match_scan_v1_done");
    if (flag) return;
    const res = await scanMatches(pool, null);
    if (res.ok) {
      await setSetting(pool, "match_scan_v1_done", true, null);
      console.log(`[post-migrate] match scan: merged=${res.data.merged} queued=${res.data.queued}`);
    }
  } catch (error) {
    // Never let a maintenance task affect the request; retried on a later boot.
    console.error("[post-migrate] task failed:", error instanceof Error ? error.message : "unknown");
  }
}
