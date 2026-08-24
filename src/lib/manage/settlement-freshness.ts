import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";

export const SETTLEMENT_SOURCE_LOCK = "ahivim:settlement-ledger-source";

export interface SettlementLedgerFreshness {
  dirty: boolean;
  sourceVersion: string;
  refreshedVersion: string;
  dirtySince: string | null;
  lastRefreshedAt: string | null;
  refreshedForDate: string | null;
  lastRefreshError: string | null;
}

interface FreshnessRow {
  source_version: string;
  refreshed_version: string;
  dirty_since: string | null;
  last_refreshed_at: string | null;
  refreshed_for_date: string | null;
  last_refresh_error: string | null;
}

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

/** The UTC date basis also used by currentBudgetPeriod's default clock. */
export function settlementApplicationDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Acquire before any row lock in a transaction that reads or writes ledger sources. */
export async function acquireSettlementSourceLock(client: PgLikeClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [SETTLEMENT_SOURCE_LOCK]);
}

function mapFreshness(row: FreshnessRow, applicationDate: string): SettlementLedgerFreshness {
  return {
    dirty:
      row.source_version !== row.refreshed_version ||
      row.refreshed_for_date !== applicationDate,
    sourceVersion: row.source_version,
    refreshedVersion: row.refreshed_version,
    dirtySince: row.dirty_since,
    lastRefreshedAt: row.last_refreshed_at,
    refreshedForDate: row.refreshed_for_date,
    lastRefreshError: row.last_refresh_error,
  };
}

async function selectFreshness(
  queryable: Queryable,
  applicationDate: string,
): Promise<SettlementLedgerFreshness> {
  const { rows } = await queryable.query<FreshnessRow>(
    `SELECT source_version::text, refreshed_version::text,
            dirty_since::text, last_refreshed_at::text,
            to_char(refreshed_for_date, 'YYYY-MM-DD') AS refreshed_for_date,
            last_refresh_error
       FROM settlement_ledger_state
      WHERE singleton = true`,
  );
  const row = rows[0];
  if (!row) {
    return {
      dirty: true,
      sourceVersion: "unknown",
      refreshedVersion: "unknown",
      dirtySince: null,
      lastRefreshedAt: null,
      refreshedForDate: null,
      lastRefreshError: "Settlement freshness state is unavailable.",
    };
  }
  return mapFreshness(row, applicationDate);
}

/** Read-only status for dashboards and health surfaces. */
export async function getSettlementLedgerFreshness(
  pool: PgLikePool,
  applicationDate: string = settlementApplicationDate(),
): Promise<SettlementLedgerFreshness> {
  return selectFreshness(pool, applicationDate);
}

/**
 * Serialize a refresh or settlement action with every relevant source write.
 * Database BEFORE STATEMENT triggers acquire the same transaction-level lock.
 */
export async function lockSettlementSources(
  client: PgLikeClient,
  applicationDate: string = settlementApplicationDate(),
): Promise<SettlementLedgerFreshness> {
  await acquireSettlementSourceLock(client);
  return selectFreshness(client, applicationDate);
}

/** A scoped refresh cannot certify the global ledger; only a full pass may. */
export async function markSettlementRefreshComplete(
  client: PgLikeClient,
  fullRefresh: boolean,
  applicationDate: string,
): Promise<void> {
  if (!fullRefresh) return;
  await client.query(
    `UPDATE settlement_ledger_state
        SET refreshed_version = source_version,
            dirty_since = NULL,
            last_refreshed_at = now(),
            refreshed_for_date = $1::date,
            last_refresh_error = NULL,
            updated_at = now()
      WHERE singleton = true`,
    [applicationDate],
  );
}

/** Keep the ledger blocked when a full pass cannot safely derive every source. */
export async function markSettlementRefreshBlocked(
  client: PgLikeClient,
  message: string,
): Promise<void> {
  await client.query(
    `UPDATE settlement_ledger_state
        SET source_version = CASE
              WHEN source_version = refreshed_version THEN source_version + 1
              ELSE source_version
            END,
            dirty_since = COALESCE(dirty_since, now()),
            last_refresh_error = $1,
            updated_at = now()
      WHERE singleton = true`,
    [message.slice(0, 500)],
  );
}

/** Best-effort diagnostics; version/date mismatch remains the authoritative block. */
export async function recordSettlementRefreshFailure(pool: PgLikePool, message: string): Promise<void> {
  await pool.query(
    `UPDATE settlement_ledger_state
        SET last_refresh_error = $1, updated_at = now()
      WHERE singleton = true`,
    [message.slice(0, 500)],
  );
}
