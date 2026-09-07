import type { PgLikePool } from "@/lib/import/commit";
import { getSetting, setSetting } from "@/lib/manage/app-settings";

/**
 * SHEET SYNC CONFIGURATION
 * ========================
 *
 * The Google Sheet is the permanent read-only source for transaction evidence.
 * Application-owned fields remain in Neon. The source identity, tab name,
 * whether the daily sync is enabled, and the hour it
 * runs are all stored in `app_settings` so they can be changed from the UI
 * without a redeploy. The Vercel Cron pings the sync endpoint on a fixed
 * cadence; the endpoint self-gates on the configured hour and a minimum
 * interval, so moving the run time is a settings change, not a code change.
 */

export const SHEET_SYNC_CONFIG_KEY = "sheet_sync_config";

/** The owner-designated, read-only transaction source. */
export const DEFAULT_SHEET_ID = "1UtpmJE98pfMVWbbSNsn4ahPYvQUm9k5Kpfxj8nFGguk";
export const DEFAULT_SHEET_NAME = "Ahivim";
/** Stable tab id for the owner-designated source; unaffected by tab renames. */
export const DEFAULT_SHEET_GID = "1743235610";

/** Previously stored transport copy. New builds read the authoritative source directly. */
export const LEGACY_TRANSPORT_SHEET_ID = "11WQ26RDH7G_9O_f7JZVgW3hKQDNiL9sRkMQH1DHv5x0";

export interface SheetSyncConfig {
  /** When false, the scheduled sync is skipped (manual refresh still works). */
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
  const requestedSheetId = (v.sheetId ?? "").trim();
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_SYNC_CONFIG.enabled,
    // Keep the stored legacy id intact for application rollback while making
    // this release use the owner-designated authoritative source.
    sheetId: !requestedSheetId || requestedSheetId === LEGACY_TRANSPORT_SHEET_ID
      ? DEFAULT_SYNC_CONFIG.sheetId
      : requestedSheetId,
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

/** A human-facing source link; access remains governed by Google permissions. */
export function sheetSourceUrl(cfg: Pick<SheetSyncConfig, "sheetId">): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.sheetId)}`;
}

/**
 * Pinned public export for the exact authoritative source. Custom or private
 * sources deliberately return null and require Viewer-only API credentials.
 */
export function authoritativeSheetExportUrl(
  cfg: Pick<SheetSyncConfig, "sheetId" | "sheetName">,
): string | null {
  if (cfg.sheetId !== DEFAULT_SHEET_ID || cfg.sheetName !== DEFAULT_SHEET_NAME) return null;
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(DEFAULT_SHEET_ID)}` +
    `/export?format=csv&gid=${encodeURIComponent(DEFAULT_SHEET_GID)}`;
}
