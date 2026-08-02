import type { PgLikePool } from "@/lib/import/commit";
import { getSetting, setSetting } from "@/lib/manage/app-settings";

/**
 * SHEET SYNC CONFIGURATION
 * ========================
 *
 * The Google Sheet is the permanent source of truth for Transactions. Its
 * identity, the tab name, whether the daily sync is enabled, and the hour it
 * runs are all stored in `app_settings` so they can be changed from the UI
 * without a redeploy. The Vercel Cron pings the sync endpoint on a fixed
 * cadence; the endpoint self-gates on the configured hour and a minimum
 * interval, so moving the run time is a settings change, not a code change.
 */

export const SHEET_SYNC_CONFIG_KEY = "sheet_sync_config";

/** The sheet supplied as the source of truth. */
export const DEFAULT_SHEET_ID = "11WQ26RDH7G_9O_f7JZVgW3hKQDNiL9sRkMQH1DHv5x0";
export const DEFAULT_SHEET_NAME = "Ahivim";

export interface SheetSyncConfig {
  /** When false, the scheduled sync is skipped (manual "Sync now" still works). */
  enabled: boolean;
  sheetId: string;
  sheetName: string;
  /** Hour of day (UTC, 0–23) the scheduled sync should run. */
  scheduleHourUtc: number;
  /** The scheduler will not start a run if one succeeded within this window. */
  minIntervalMinutes: number;
}

export const DEFAULT_SYNC_CONFIG: SheetSyncConfig = {
  enabled: true,
  sheetId: DEFAULT_SHEET_ID,
  sheetName: DEFAULT_SHEET_NAME,
  scheduleHourUtc: 8,
  minIntervalMinutes: 60,
};

function coerce(value: Partial<SheetSyncConfig> | null): SheetSyncConfig {
  const v = value ?? {};
  const hour = Number(v.scheduleHourUtc);
  const interval = Number(v.minIntervalMinutes);
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_SYNC_CONFIG.enabled,
    sheetId: (v.sheetId ?? "").trim() || DEFAULT_SYNC_CONFIG.sheetId,
    sheetName: (v.sheetName ?? "").trim() || DEFAULT_SYNC_CONFIG.sheetName,
    scheduleHourUtc: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_SYNC_CONFIG.scheduleHourUtc,
    minIntervalMinutes:
      Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : DEFAULT_SYNC_CONFIG.minIntervalMinutes,
  };
}

export async function getSyncConfig(pool: PgLikePool): Promise<SheetSyncConfig> {
  const stored = await getSetting<Partial<SheetSyncConfig>>(pool, SHEET_SYNC_CONFIG_KEY);
  return coerce(stored);
}

export async function setSyncConfig(
  pool: PgLikePool,
  patch: Partial<SheetSyncConfig>,
  actorId: string | null,
): Promise<SheetSyncConfig> {
  const current = await getSyncConfig(pool);
  const next = coerce({ ...current, ...patch });
  await setSetting(pool, SHEET_SYNC_CONFIG_KEY, next, actorId);
  return next;
}

/** The gviz CSV export URL for the configured sheet + tab (link-share, no auth). */
export function gvizCsvUrl(cfg: Pick<SheetSyncConfig, "sheetId" | "sheetName">): string {
  const id = encodeURIComponent(cfg.sheetId);
  const tab = encodeURIComponent(cfg.sheetName);
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${tab}`;
}

/** A human-facing link to the sheet, for the UI. */
export function sheetEditUrl(cfg: Pick<SheetSyncConfig, "sheetId">): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.sheetId)}/edit`;
}
