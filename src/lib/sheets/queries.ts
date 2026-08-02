import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "@/lib/manage/audit";

/** Read models for the Sync screen. Nothing here mutates state. */

export interface SyncRunRow {
  id: string;
  trigger: string;
  status: string;
  sourceRows: number;
  added: number;
  updated: number;
  skipped: number;
  flagged: number;
  failed: number;
  importBatchId: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: string | null;
  reconciliationNote: string | null;
}

export interface SyncStatus {
  lastSuccessAt: string | null;
  lastRun: SyncRunRow | null;
  openChanged: number;
  openMissing: number;
  trackedRows: number;
  totalRuns: number;
}

export interface SyncConflictRow {
  id: string;
  type: string;
  status: string;
  audited: boolean;
  naturalKey: string;
  detail: string | null;
  previous: Record<string, unknown> | null;
  incoming: Record<string, unknown> | null;
  transactionId: string | null;
  individualName: string | null;
  employeeName: string | null;
  programName: string | null;
  createdAt: string;
}

function mapRun(r: {
  id: string; trigger: string; status: string; source_rows: number; rows_added: number;
  rows_updated: number; rows_skipped: number; rows_flagged: number; rows_failed: number;
  import_batch_id: string | null; error_message: string | null; started_at: string;
  finished_at: string | null; triggered_by: string | null; reconciliation: { note?: string } | null;
}): SyncRunRow {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    sourceRows: r.source_rows,
    added: r.rows_added,
    updated: r.rows_updated,
    skipped: r.rows_skipped,
    flagged: r.rows_flagged,
    failed: r.rows_failed,
    importBatchId: r.import_batch_id,
    errorMessage: r.error_message,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    triggeredBy: r.triggered_by,
    reconciliationNote: r.reconciliation?.note ?? null,
  };
}

export async function listSyncRuns(pool: PgLikePool, limit = 50): Promise<SyncRunRow[]> {
  const capped = Math.min(Math.max(limit, 1), 200);
  const { rows } = await pool.query(
    `SELECT r.id, r.trigger, r.status, r.source_rows, r.rows_added, r.rows_updated,
            r.rows_skipped, r.rows_flagged, r.rows_failed, r.import_batch_id, r.error_message,
            r.started_at::text AS started_at, r.finished_at::text AS finished_at,
            u.display_name AS triggered_by, r.reconciliation
       FROM sheet_sync_runs r
       LEFT JOIN users u ON u.id = r.triggered_by_user_id
      ORDER BY r.started_at DESC
      LIMIT $1`,
    [capped],
  );
  return (rows as Parameters<typeof mapRun>[0][]).map(mapRun);
}

export async function getSyncStatus(pool: PgLikePool): Promise<SyncStatus> {
  const { rows: successRows } = await pool.query<{ finished_at: string | null }>(
    `SELECT finished_at::text AS finished_at FROM sheet_sync_runs
      WHERE status = 'success' ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
  );
  const { rows: lastRows } = await pool.query(
    `SELECT r.id, r.trigger, r.status, r.source_rows, r.rows_added, r.rows_updated,
            r.rows_skipped, r.rows_flagged, r.rows_failed, r.import_batch_id, r.error_message,
            r.started_at::text AS started_at, r.finished_at::text AS finished_at,
            u.display_name AS triggered_by, r.reconciliation
       FROM sheet_sync_runs r
       LEFT JOIN users u ON u.id = r.triggered_by_user_id
      ORDER BY r.started_at DESC LIMIT 1`,
  );
  const { rows: conflictCounts } = await pool.query<{ type: string; c: string }>(
    `SELECT type, count(*)::text AS c FROM sheet_sync_conflicts WHERE status = 'open' GROUP BY type`,
  );
  const { rows: tracked } = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM sheet_sync_rows WHERE payroll_transaction_id IS NOT NULL`,
  );
  const { rows: totalRuns } = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM sheet_sync_runs`,
  );

  const byType = new Map(conflictCounts.map((r) => [r.type, Number(r.c)]));
  return {
    lastSuccessAt: successRows[0]?.finished_at ?? null,
    lastRun: lastRows[0] ? mapRun((lastRows as Parameters<typeof mapRun>[0][])[0]) : null,
    openChanged: byType.get("changed") ?? 0,
    openMissing: byType.get("missing") ?? 0,
    trackedRows: Number(tracked[0]?.c ?? 0),
    totalRuns: Number(totalRuns[0]?.c ?? 0),
  };
}

export async function listOpenConflicts(
  pool: PgLikePool,
  filter: { type?: "changed" | "missing"; limit?: number } = {},
): Promise<SyncConflictRow[]> {
  const type = filter.type ?? null;
  const capped = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  const { rows } = await pool.query<{
    id: string; type: string; status: string; audited: boolean; natural_key: string;
    detail: string | null; previous: Record<string, unknown> | null; incoming: Record<string, unknown> | null;
    payroll_transaction_id: string | null; individual_name: string | null; employee_name: string | null;
    program_name: string | null; created_at: string;
  }>(
    `SELECT c.id, c.type, c.status, c.audited, c.natural_key, c.detail, c.previous, c.incoming,
            c.payroll_transaction_id, i.display_name AS individual_name, e.display_name AS employee_name,
            p.name AS program_name, c.created_at::text AS created_at
       FROM sheet_sync_conflicts c
       LEFT JOIN payroll_transactions t ON t.id = c.payroll_transaction_id
       LEFT JOIN individuals i ON i.id = t.individual_id
       LEFT JOIN employees e ON e.id = t.employee_id
       LEFT JOIN programs p ON p.id = t.program_id
      WHERE c.status = 'open' AND ($1::text IS NULL OR c.type = $1)
      ORDER BY c.created_at DESC
      LIMIT $2`,
    [type, capped],
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    audited: r.audited,
    naturalKey: r.natural_key,
    detail: r.detail,
    previous: r.previous,
    incoming: r.incoming,
    transactionId: r.payroll_transaction_id,
    individualName: r.individual_name,
    employeeName: r.employee_name,
    programName: r.program_name,
    createdAt: r.created_at,
  }));
}

/** Delete finished run records. Tracking rows and open conflicts are preserved. */
export async function clearSyncHistory(pool: PgLikePool, actorId: string | null): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM sheet_sync_runs WHERE status <> 'running'`,
  );
  await recordChange(pool, {
    actorId,
    action: "sheet_sync_history_cleared",
    entityType: "sheet_sync_run",
    entityId: null,
    extra: { deleted: rowCount ?? 0 },
  });
  return rowCount ?? 0;
}
