import type { PgLikePool } from "@/lib/import/commit";
import { getSyncConfig, type SheetSyncConfig } from "./config";
import { runSheetSync, type SyncRunSummary } from "./sync";
import {
  acknowledgePaidWriteback,
  protectPaidWriteback,
  pushPaidChangesToSheet,
  type SheetWritebackResult,
} from "./writeback";

export interface SheetRoundTripResult {
  summary: SyncRunSummary;
  writeback: SheetWritebackResult;
}

export function sheetRoundTripSucceeded(result: SheetRoundTripResult): boolean {
  return result.summary.status !== "failed"
    && (result.writeback.status === "success" || result.writeback.status === "not_configured");
}

/**
 * Send app-owned Paid changes first, then always pull the latest sheet. A
 * write-back configuration problem never prevents the read-only refresh.
 */
export async function runSheetRoundTrip(
  pool: PgLikePool,
  options: {
    userId: string | null;
    /** Test seams for proving ordering without a database. */
    config?: SheetSyncConfig;
    push?: typeof pushPaidChangesToSheet;
    pull?: typeof runSheetSync;
    acknowledge?: typeof acknowledgePaidWriteback;
    protect?: typeof protectPaidWriteback;
  },
): Promise<SheetRoundTripResult> {
  const config = options.config ?? await getSyncConfig(pool);
  const writeback = await (options.push ?? pushPaidChangesToSheet)(pool, config);
  if (writeback.status === "success" || writeback.status === "partial") {
    await (options.protect ?? protectPaidWriteback)(
      pool,
      writeback.synchronizedTransactions,
    );
  }
  const summary = await (options.pull ?? runSheetSync)(pool, {
    trigger: "manual",
    userId: options.userId,
    config,
  });
  if ((writeback.status === "success" || writeback.status === "partial") && summary.status !== "failed") {
    await (options.acknowledge ?? acknowledgePaidWriteback)(
      pool,
      writeback.synchronizedTransactions,
    );
  }
  return { summary, writeback };
}
