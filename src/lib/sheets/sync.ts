import type { PgLikePool } from "@/lib/import/commit";
import { commitStagedImport } from "@/lib/import/commit";
import { stageAgainstDatabase } from "@/lib/import/pipeline";
import { currentRatesByProgram } from "@/lib/data/queries";
import type { StagingResult, StagedRow } from "@/lib/import/stage";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";
import { transactionNaturalKey, type TransactionIdentity } from "@/lib/business/fingerprint";
import { recordChange } from "@/lib/manage/audit";
import { parseSheetCsv } from "./parse-csv";
import { fetchSheetCsv, type CsvFetcher, SheetFetchError } from "./fetch";
import { getSyncConfig, type SheetSyncConfig } from "./config";
import { sheetSourceIdentity } from "./identity";
import { autoReconcile } from "@/lib/manage/reconciliation";

/**
 * SHEET SYNC ENGINE
 * =================
 *
 * The Google Sheet is the permanent source of truth for Transactions. A sync
 * fetches the sheet, maps it into the SAME parsed-row shape the workbook
 * importer produces, and drives it through the SAME staging + commit pipeline,
 * so matching, attribution, group detection, rate logic, reconciliation,
 * fingerprint de-duplication and audit are all inherited unchanged.
 *
 * On top of the pipeline the engine adds exactly what daily syncing needs, and
 * nothing more:
 *
 *   • NEW rows (identity never seen in the ledger) → imported as transactions.
 *   • UNCHANGED rows (fingerprint already in the ledger) → skipped, never
 *     re-imported. This is the pipeline's own duplicate guard.
 *   • CHANGED rows (same identity, different money/hours) → NEVER silently
 *     rewritten. The incoming row is held out of the ledger and a conflict is
 *     opened for review. If the existing transaction carries an audited manual
 *     correction the conflict is marked so, and applying it is refused.
 *   • MISSING rows (a previously-synced identity absent from the sheet) → NEVER
 *     deleted. The transaction is flagged and a conflict is opened for review.
 *
 * Every run is recorded (added / updated / skipped / flagged / failed, the
 * reconciliation, and any error) so the last successful sync, the counts, the
 * history and any failure are all visible and retryable.
 */

export interface RunSheetSyncOptions {
  trigger: "manual" | "scheduled" | "initial";
  userId: string | null;
  /** Injectable for tests; defaults to the real server-side fetch. */
  fetcher?: CsvFetcher;
  /** Override config (tests); defaults to the stored configuration. */
  config?: SheetSyncConfig;
}

export interface SyncRunSummary {
  runId: string;
  status: "success" | "failed" | "no_changes";
  trigger: string;
  sourceRows: number;
  added: number;
  updated: number;
  skipped: number;
  flagged: number;
  failed: number;
  changed: number;
  missing: number;
  importBatchId: string | null;
  reconciliation: (Partial<StagingResult["reconciliation"]> & {
    note: string;
    scheduleMatching?: ScheduleMatchingOutcome;
  }) | null;
  error: string | null;
  note: string;
}

export interface ScheduleMatchingOutcome {
  status: "not_needed" | "checked" | "needs_review";
  matched: number;
  considered: number;
  from: string | null;
  to: string | null;
  reviewHref: "/schedule?view=matching";
}

const SCHEDULE_MATCH_REVIEW_HREF = "/schedule?view=matching" as const;

/**
 * Schedule matching is a useful follow-up to an import, but it is not part of
 * the transaction commit. A temporary matching failure must never rewrite the
 * committed import as failed.
 */
export async function attemptOptionalScheduleMatching(
  range: { from: string; to: string },
  reconcile: () => ReturnType<typeof autoReconcile>,
): Promise<ScheduleMatchingOutcome> {
  try {
    const result = await reconcile();
    if (result.ok) {
      return {
        status: "checked",
        ...result.data,
        ...range,
        reviewHref: SCHEDULE_MATCH_REVIEW_HREF,
      };
    }
  } catch {
    // The retry range is retained below so a later unchanged sync can try again.
  }
  return {
    status: "needs_review",
    matched: 0,
    considered: 0,
    ...range,
    reviewHref: SCHEDULE_MATCH_REVIEW_HREF,
  };
}

function noScheduleMatchingNeeded(): ScheduleMatchingOutcome {
  return {
    status: "not_needed",
    matched: 0,
    considered: 0,
    from: null,
    to: null,
    reviewHref: SCHEDULE_MATCH_REVIEW_HREF,
  };
}

function scheduleMatchingNote(outcome: ScheduleMatchingOutcome): string {
  if (outcome.status === "needs_review") {
    return "Automatic schedule matching needs attention. The transaction data is saved; use Sync now to retry or open Schedule matching.";
  }
  if (outcome.status === "not_needed") {
    return "No new dated transactions needed a schedule-matching check.";
  }
  return `Schedule matching checked ${outcome.considered} eligible planned visit${outcome.considered === 1 ? "" : "s"}; ${outcome.matched} exact daily record${outcome.matched === 1 ? " was" : "s were"} connected. Other records remain in Schedule matching for review.`;
}

interface LedgerTxn {
  id: string;
  fingerprint: string;
  naturalKey: string;
  identity: {
    checkNumber: string | null;
    checkDate: string | null;
    program: string | null;
    individual: string | null;
    employee: string | null;
    periodBegin: string | null;
    periodEnd: string | null;
    hours: string;
    rate: string;
    amount: string;
  };
}

interface Ledger {
  fingerprints: Set<string>;
  naturalKeys: Set<string>;
  byFingerprint: Map<string, LedgerTxn>;
  byNaturalKey: Map<string, LedgerTxn[]>;
}

export type ChangedLedgerMatch<T> =
  | { kind: "missing" }
  | { kind: "single"; target: T }
  | { kind: "ambiguous"; candidates: readonly T[] };

/**
 * A natural key intentionally excludes money and hours, and the schema permits
 * several legitimate transactions to share one. A changed source row is safe
 * to associate automatically only when exactly one ledger candidate exists.
 */
export function classifyChangedLedgerMatch<T>(candidates: readonly T[]): ChangedLedgerMatch<T> {
  if (candidates.length === 0) return { kind: "missing" };
  if (candidates.length === 1) return { kind: "single", target: candidates[0]! };
  return { kind: "ambiguous", candidates };
}

export type TrackedSourcePresence = "present" | "changed" | "missing";

/** Exact fingerprints distinguish legitimate line items that share a natural key. */
export function classifyTrackedSourcePresence(
  tracked: { fingerprint: string; naturalKey: string },
  snapshot: { fingerprints: ReadonlySet<string>; changedNaturalKeys: ReadonlySet<string> },
): TrackedSourcePresence {
  if (snapshot.fingerprints.has(tracked.fingerprint)) return "present";
  if (snapshot.changedNaturalKeys.has(tracked.naturalKey)) return "changed";
  return "missing";
}

/**
 * Read the current transaction ledger and build the reference sets the sync
 * classifier needs. Mirrors loadStagingContext's committed-transactions query,
 * additionally returning the transaction id and a stable natural key per row.
 */
async function loadLedger(pool: PgLikePool): Promise<Ledger> {
  const { rows } = await pool.query<{
    id: string;
    check_number: string | null;
    check_date: string | null;
    employee_key: string | null;
    individual_key: string | null;
    program_code: string | null;
    period_begin: string | null;
    period_end: string | null;
    hours: string | null;
    rate: string | null;
    amount: string | null;
    transaction_fingerprint: string;
  }>(`
    SELECT t.id,
           t.check_number,
           t.check_date::text       AS check_date,
           e.normalized_name        AS employee_key,
           i.normalized_name        AS individual_key,
           p.code                   AS program_code,
           t.period_begin::text     AS period_begin,
           t.period_end::text       AS period_end,
           t.imported_hours::text   AS hours,
           t.imported_rate::text    AS rate,
           t.imported_amount::text  AS amount,
           t.transaction_fingerprint
      FROM payroll_transactions t
      LEFT JOIN programs p    ON p.id = t.program_id
      LEFT JOIN individuals i ON i.id = t.individual_id
      LEFT JOIN employees e   ON e.id = t.employee_id
  `);

  const ledger: Ledger = {
    fingerprints: new Set(),
    naturalKeys: new Set(),
    byFingerprint: new Map(),
    byNaturalKey: new Map(),
  };

  for (const r of rows) {
    const identity: TransactionIdentity = {
      checkNumber: r.check_number,
      checkDate: r.check_date,
      employeeKey: r.employee_key,
      individualKey: r.individual_key ?? "",
      programKey: r.program_code,
      periodBegin: r.period_begin,
      periodEnd: r.period_end,
      hours: r.hours ?? "0",
      rate: r.rate ?? "0",
      amount: r.amount ?? "0",
    };
    const naturalKey = transactionNaturalKey(identity);
    const txn: LedgerTxn = {
      id: r.id,
      fingerprint: r.transaction_fingerprint,
      naturalKey,
      identity: {
        checkNumber: r.check_number,
        checkDate: r.check_date,
        program: r.program_code,
        individual: r.individual_key,
        employee: r.employee_key,
        periodBegin: r.period_begin,
        periodEnd: r.period_end,
        hours: r.hours ?? "0",
        rate: r.rate ?? "0",
        amount: r.amount ?? "0",
      },
    };
    ledger.fingerprints.add(txn.fingerprint);
    ledger.naturalKeys.add(naturalKey);
    ledger.byFingerprint.set(txn.fingerprint, txn);
    const list = ledger.byNaturalKey.get(naturalKey) ?? [];
    list.push(txn);
    ledger.byNaturalKey.set(naturalKey, list);
  }
  return ledger;
}

/** Does the transaction (or its import row) carry an audited manual correction? */
async function isTransactionAudited(pool: PgLikePool, txnId: string): Promise<boolean> {
  // A manual "audited correction" is signalled by a field correction on the
  // import row (correction_status = 'corrected' / corrected_values). The
  // resolved_*_id columns are NOT used: normal imports populate them with the
  // auto-matched canonical ids, so they are not a sign of human curation.
  const { rows } = await pool.query<{ audited: boolean }>(
    `SELECT EXISTS (
        SELECT 1
          FROM payroll_transactions t
          JOIN import_rows r ON r.id = t.import_row_id
         WHERE t.id = $1
           AND ( r.correction_status = 'corrected' OR r.corrected_values IS NOT NULL )
     ) AS audited`,
    [txnId],
  );
  return rows[0]?.audited === true;
}

function storedScheduleMatching(value: unknown): ScheduleMatchingOutcome | null {
  if (!value || typeof value !== "object") return null;
  const stored = value as Partial<ScheduleMatchingOutcome>;
  if (
    !["not_needed", "checked", "needs_review"].includes(stored.status ?? "")
    || typeof stored.matched !== "number"
    || typeof stored.considered !== "number"
  ) return null;
  return {
    status: stored.status!,
    matched: stored.matched,
    considered: stored.considered,
    from: typeof stored.from === "string" ? stored.from : null,
    to: typeof stored.to === "string" ? stored.to : null,
    reviewHref: SCHEDULE_MATCH_REVIEW_HREF,
  };
}

interface LastSuccessfulSync {
  snapshotSha256: string;
  scheduleMatching: ScheduleMatchingOutcome | null;
}

async function lastSuccessfulSync(pool: PgLikePool, excludeRunId: string): Promise<LastSuccessfulSync | null> {
  const { rows } = await pool.query<{
    snapshot_sha256: string | null;
    schedule_matching: unknown;
  }>(
    `SELECT snapshot_sha256, reconciliation->'scheduleMatching' AS schedule_matching
       FROM sheet_sync_runs
      WHERE status IN ('success','no_changes') AND id <> $1 AND snapshot_sha256 IS NOT NULL
      ORDER BY started_at DESC, id DESC LIMIT 1`,
    [excludeRunId],
  );
  const row = rows[0];
  if (!row?.snapshot_sha256) return null;
  return {
    snapshotSha256: row.snapshot_sha256,
    scheduleMatching: storedScheduleMatching(row.schedule_matching),
  };
}

async function finishRun(
  pool: PgLikePool,
  runId: string,
  patch: {
    status: string;
    sourceRows?: number;
    added?: number;
    updated?: number;
    skipped?: number;
    flagged?: number;
    failed?: number;
    importBatchId?: string | null;
    reconciliation?: unknown;
    error?: string | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE sheet_sync_runs
        SET status = $2,
            source_rows = COALESCE($3, source_rows),
            rows_added = COALESCE($4, rows_added),
            rows_updated = COALESCE($5, rows_updated),
            rows_skipped = COALESCE($6, rows_skipped),
            rows_flagged = COALESCE($7, rows_flagged),
            rows_failed = COALESCE($8, rows_failed),
            import_batch_id = COALESCE($9, import_batch_id),
            reconciliation = COALESCE($10::jsonb, reconciliation),
            error_message = $11,
            finished_at = now()
      WHERE id = $1`,
    [
      runId,
      patch.status,
      patch.sourceRows ?? null,
      patch.added ?? null,
      patch.updated ?? null,
      patch.skipped ?? null,
      patch.flagged ?? null,
      patch.failed ?? null,
      patch.importBatchId ?? null,
      patch.reconciliation != null ? JSON.stringify(patch.reconciliation) : null,
      patch.error ?? null,
    ],
  );
}

export async function runSheetSync(
  pool: PgLikePool,
  opts: RunSheetSyncOptions,
): Promise<SyncRunSummary> {
  const config = opts.config ?? (await getSyncConfig(pool));
  const fetcher: CsvFetcher = opts.fetcher ?? fetchSheetCsv;

  const { rows: runRows } = await pool.query<{ id: string }>(
    `INSERT INTO sheet_sync_runs (trigger, status, triggered_by_user_id)
     VALUES ($1, 'running', $2) RETURNING id`,
    [opts.trigger, opts.userId],
  );
  const runId = runRows[0]!.id;

  const base: SyncRunSummary = {
    runId,
    status: "failed",
    trigger: opts.trigger,
    sourceRows: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    flagged: 0,
    failed: 0,
    changed: 0,
    missing: 0,
    importBatchId: null,
    reconciliation: null,
    error: null,
    note: "",
  };

  try {
    // 1. Fetch + parse the sheet.
    const csv = await fetcher(config);
    const parse = parseSheetCsv(csv);
    const parsedRows = parse.ahivimRows;
    base.sourceRows = parsedRows.length;

    await pool.query(
      `UPDATE sheet_sync_runs SET snapshot_sha256 = $2, source_rows = $3 WHERE id = $1`,
      [runId, parse.snapshotSha256, parsedRows.length],
    );

    if (parsedRows.length === 0) {
      throw new SheetFetchError(
        "No transaction rows were found in the sheet. Nothing was imported. Confirm the tab name " +
          "and that the sheet still contains data.",
      );
    }

    // 2. No-op fast path: the sheet is byte-for-content identical to the last good run.
    const priorSync = await lastSuccessfulSync(pool, runId);
    if (priorSync?.snapshotSha256 === parse.snapshotSha256) {
      const pendingMatch = priorSync.scheduleMatching;
      const scheduleMatching = pendingMatch?.status === "needs_review" && pendingMatch.from && pendingMatch.to
        ? await attemptOptionalScheduleMatching(
            { from: pendingMatch.from, to: pendingMatch.to },
            () => autoReconcile(pool, { from: pendingMatch.from!, to: pendingMatch.to! }, opts.userId),
          )
        : null;
      const reconciliationNote = scheduleMatching
        ? `Sheet unchanged since the last successful sync. ${scheduleMatchingNote(scheduleMatching)}`
        : "Sheet unchanged since the last successful sync.";
      await finishRun(pool, runId, {
        status: "no_changes",
        sourceRows: parsedRows.length,
        added: 0,
        updated: 0,
        skipped: parsedRows.length,
        flagged: 0,
        failed: 0,
        reconciliation: scheduleMatching
          ? { note: reconciliationNote, scheduleMatching }
          : { note: reconciliationNote },
      });
      return {
        ...base,
        status: "no_changes",
        skipped: parsedRows.length,
        reconciliation: scheduleMatching
          ? { note: reconciliationNote, scheduleMatching }
          : null,
        note: scheduleMatching
          ? `The sheet is unchanged; no transactions were imported. ${scheduleMatchingNote(scheduleMatching)}`
          : "The sheet is unchanged since the last successful sync; nothing was imported.",
      };
    }

    // 3. Stage against the current database (reuses all business logic).
    const staging = await stageAgainstDatabase(pool, parsedRows, {
      agencyGross: parse.controlTotals.agencyGross,
      internalAmount: parse.controlTotals.internalAmount,
    });

    // 4. Classify every row against the ledger and hold CHANGED rows out of the commit.
    const ledger = await loadLedger(pool);
    const parsedByRow = new Map<number, ParsedAhivimRow>(parsedRows.map((r) => [r.sourceRowNumber, r]));

    const changed: { staged: StagedRow; parsed: ParsedAhivimRow }[] = [];
    const snapshotFingerprints = new Set<string>();
    let unchangedCount = 0;
    let invalidCount = 0;

    for (const st of staging.rows) {
      if (st.status === "invalid" || !st.fingerprint || !st.naturalKey) {
        invalidCount++;
        continue;
      }
      snapshotFingerprints.add(st.fingerprint);

      if (ledger.fingerprints.has(st.fingerprint)) {
        unchangedCount++;
        continue; // pipeline will treat this as a confirmed duplicate: not re-imported
      }
      if (ledger.naturalKeys.has(st.naturalKey)) {
        // CHANGED: neutralise so commit preserves it in import_rows but writes NO
        // transaction, then record a conflict for review.
        st.status = "needs_review";
        const parsed = parsedByRow.get(st.sourceRowNumber);
        if (parsed) changed.push({ staged: st, parsed });
      }
      // else NEW → left as-is; commit imports it.
    }

    // Counts consumed by commit for the batch summary are now stale; refresh them.
    staging.counts.valid = staging.rows.filter((r) => r.status === "valid").length;
    staging.counts.needsReview = staging.rows.filter((r) => r.status === "needs_review").length;

    // 5. Commit — imports NEW rows only; unchanged are skipped, changed are held.
    const ratesByProgram = await currentRatesByProgram(pool);
    const commitResult = await commitStagedImport(pool, {
      checksumSha256: parse.snapshotSha256,
      originalFilename: `Google Sheet sync — ${config.sheetName}`,
      byteSize: Buffer.byteLength(csv, "utf8"),
      templateDetected: "ahivim_sheet_v1",
      sheetSummary: {
        kind: "sheet_sync_v1",
        sheetId: config.sheetId,
        sheetName: config.sheetName,
        snapshot: parse.snapshotSha256,
        controlTotals: parse.controlTotals,
        totalSourceRows: parsedRows.length,
        warnings: parse.warnings,
        syncRunId: runId,
      },
      parsedRows,
      staging,
      ratesByProgram,
      committedByUserId: opts.userId,
    });
    base.importBatchId = commitResult.importBatchId;
    base.reconciliation = staging.reconciliation;

    // 6. Map fingerprints → transaction ids for THIS run's writes (new rows) and
    //    reuse the ledger for unchanged rows, so every current row can be tracked.
    const newTxnByFingerprint = new Map<string, string>();
    if (!commitResult.alreadyCommitted) {
      const { rows: newTxns } = await pool.query<{ id: string; transaction_fingerprint: string }>(
        `SELECT id, transaction_fingerprint FROM payroll_transactions WHERE import_batch_id = $1`,
        [commitResult.importBatchId],
      );
      for (const t of newTxns) newTxnByFingerprint.set(t.transaction_fingerprint, t.id);
    }

    // 7. Upsert tracking rows for every current, non-changed row and mark them
    //    active. Built as ONE bulk upsert (keyed by transaction id) rather than a
    //    per-row round-trip, so a full sheet of thousands of rows stays fast and
    //    finishes well inside the function's time budget.
    const changedRowNumbers = new Set(changed.map((c) => c.staged.sourceRowNumber));
    const trackByTxn = new Map<
      string,
      {
        naturalKey: string;
        fingerprint: string;
        sourceRowNumber: number;
        identity: Record<string, unknown>;
        sourcePaid: boolean;
        wasUnchanged: boolean;
      }
    >();
    for (const st of staging.rows) {
      if (!st.fingerprint || !st.naturalKey) continue;
      if (changedRowNumbers.has(st.sourceRowNumber)) continue;

      const wasUnchanged = ledger.fingerprints.has(st.fingerprint);
      const txnId = wasUnchanged
        ? ledger.byFingerprint.get(st.fingerprint)?.id ?? null
        : newTxnByFingerprint.get(st.fingerprint) ?? null;
      if (!txnId) continue; // a genuinely-new row that stayed in review (e.g. unknown program): no transaction yet

      const parsed = parsedByRow.get(st.sourceRowNumber);
      const identity = parsed ? sheetSourceIdentity(parsed) : {};
      const sourcePaid = "sourcePaid" in identity && identity.sourcePaid === true;
      // De-dup by transaction id: two identical sheet rows share a fingerprint
      // and would otherwise hit the same ON CONFLICT target twice in one insert.
      // At the canonical transaction grain, any marked duplicate occurrence is
      // paid; all occurrences must be clear before the source can clear it.
      const existing = trackByTxn.get(txnId);
      if (existing) {
        existing.sourceRowNumber = Math.min(existing.sourceRowNumber, st.sourceRowNumber);
        existing.sourcePaid = existing.sourcePaid || sourcePaid;
        existing.identity = { ...existing.identity, sourcePaid: existing.sourcePaid };
        continue;
      }
      trackByTxn.set(txnId, {
        naturalKey: st.naturalKey,
        fingerprint: st.fingerprint,
        sourceRowNumber: st.sourceRowNumber,
        identity,
        sourcePaid,
        wasUnchanged,
      });
    }

    const activeTxnIds = [...trackByTxn.keys()];
    const { rows: pendingPaidRows } = activeTxnIds.length > 0
      ? await pool.query<{ payroll_transaction_id: string }>(
          `SELECT payroll_transaction_id
             FROM sheet_sync_rows
            WHERE payroll_transaction_id = ANY($1::uuid[])
              AND identity->>'appPaidDirty' = 'true'`,
          [activeTxnIds],
        )
      : { rows: [] };
    const pendingPaidIds = new Set(pendingPaidRows.map((row) => row.payroll_transaction_id));
    let added = 0;
    for (const v of trackByTxn.values()) if (!v.wasUnchanged) added++;

    // Bulk upsert in chunks so the parameter arrays stay a sane size.
    const txnEntries = [...trackByTxn.entries()];
    const CHUNK = 500;
    for (let i = 0; i < txnEntries.length; i += CHUNK) {
      const slice = txnEntries.slice(i, i + CHUNK);
      await pool.query(
        `INSERT INTO sheet_sync_rows
           (natural_key, fingerprint, source_row_number, payroll_transaction_id, identity,
            state, first_seen_run_id, last_seen_run_id, last_seen_at)
         SELECT nk, fp, srn, txn::uuid, ident::jsonb, 'active', $6::uuid, $6::uuid, now()
           FROM unnest($1::text[], $2::text[], $3::int[], $4::uuid[], $5::text[])
                AS t(nk, fp, srn, txn, ident)
         ON CONFLICT (payroll_transaction_id) DO UPDATE
           SET natural_key = EXCLUDED.natural_key,
               fingerprint = EXCLUDED.fingerprint,
               source_row_number = EXCLUDED.source_row_number,
               identity = EXCLUDED.identity || CASE
                 WHEN sheet_sync_rows.identity->>'appPaidDirty' = 'true'
                   THEN '{"appPaidDirty":true}'::jsonb
                 ELSE '{}'::jsonb
               END,
               state = 'active',
               last_seen_run_id = EXCLUDED.last_seen_run_id,
               last_seen_at = now(),
               updated_at = now()`,
        [
          slice.map(([, v]) => v.naturalKey),
          slice.map(([, v]) => v.fingerprint),
          slice.map(([, v]) => v.sourceRowNumber),
          slice.map(([txn]) => txn),
          slice.map(([, v]) => JSON.stringify(v.identity)),
          runId,
        ],
      );
    }

    // Apply the sheet's "Paid" column onto the matched transactions. When a Paid
    // column exists, the sheet is the source of truth: any value marks the row
    // paid (stamping paid_at the first time), a "no"/blank in a present column
    // clears it. When there is NO Paid column we never touch is_paid, so in-app
    // marking is preserved. This runs for every present row (new or unchanged),
    // so an "already paid" backlog in the sheet flows in on the next sync.
    let paidMarked = 0;
    if (parse.paidColumnFound) {
      const paidIds: string[] = [];
      const unpaidIds: string[] = [];
      for (const [txnId, v] of trackByTxn) {
        if (pendingPaidIds.has(txnId)) continue;
        if (v.sourcePaid) paidIds.push(txnId);
        else unpaidIds.push(txnId);
      }
      for (let i = 0; i < paidIds.length; i += CHUNK) {
        const r = await pool.query(
          `UPDATE payroll_transactions
              SET is_paid = true, paid_at = COALESCE(paid_at, now()), updated_at = now()
            WHERE id = ANY($1::uuid[]) AND is_paid IS DISTINCT FROM true`,
          [paidIds.slice(i, i + CHUNK)],
        );
        paidMarked += r.rowCount ?? 0;
      }
      for (let i = 0; i < unpaidIds.length; i += CHUNK) {
        await pool.query(
          `UPDATE payroll_transactions
              SET is_paid = false, paid_at = NULL, updated_at = now()
            WHERE id = ANY($1::uuid[]) AND is_paid IS DISTINCT FROM false`,
          [unpaidIds.slice(i, i + CHUNK)],
        );
      }
    }

    // A row that had been flagged missing/changed but is present-and-identical again
    // clears its flag and its open missing conflict.
    if (activeTxnIds.length > 0) {
      await pool.query(
        `UPDATE payroll_transactions SET sync_review_reason = NULL, updated_at = now()
          WHERE id = ANY($1::uuid[]) AND sync_review_reason IS NOT NULL`,
        [activeTxnIds],
      );
      await pool.query(
        `UPDATE sheet_sync_conflicts
            SET status = 'dismissed', resolution = 'reappeared', resolved_at = now(), updated_at = now()
          WHERE payroll_transaction_id = ANY($1::uuid[]) AND status = 'open' AND type = 'missing'`,
        [activeTxnIds],
      );
    }

    // 8. CHANGED conflicts — never overwrite; flag for review, audited-aware.
    const changedNaturalKeys = new Set(changed.map((row) => row.staged.naturalKey!).filter(Boolean));
    // Rebuild the open changed set from the current snapshot. Superseding every
    // prior conflict for a still-changed identity before inserting the current
    // rows preserves more than one legitimate changed occurrence with the same
    // coarse natural key, rather than allowing the last row to hide the others.
    await pool.query(
      `UPDATE sheet_sync_conflicts
          SET status = 'superseded', resolution = 'newer_source_snapshot',
              resolved_at = now(), updated_at = now()
        WHERE type = 'changed' AND status = 'open'
          AND natural_key = ANY($1::text[])`,
      [[...changedNaturalKeys]],
    );
    // A prior change is no longer actionable once its natural key is not
    // changed in the current snapshot (it either reverted or became missing).
    // Missing detection below will open the current, more accurate state.
    await pool.query(
      `UPDATE sheet_sync_conflicts
          SET status = 'dismissed', resolution = 'source_no_longer_changed',
              resolved_at = now(), updated_at = now()
        WHERE type = 'changed' AND status = 'open'
          AND NOT (natural_key = ANY($1::text[]))`,
      [[...changedNaturalKeys]],
    );

    let changedCount = 0;
    for (const { staged, parsed } of changed) {
      const ledgerTxns = ledger.byNaturalKey.get(staged.naturalKey!) ?? [];
      const match = classifyChangedLedgerMatch(ledgerTxns);
      if (match.kind === "missing") continue;
      if (match.kind === "ambiguous") {
        // A natural key can legitimately identify more than one line item. Do
        // not guess which transaction changed: preserve the held source row as
        // one non-applicable review item with no transaction target.
        await pool.query(
          `INSERT INTO sheet_sync_conflicts
             (run_id, payroll_transaction_id, type, audited, natural_key, previous, incoming, detail, status)
           VALUES ($1,NULL,'changed',false,$2,$3::jsonb,$4::jsonb,$5,'open')`,
          [
            runId,
            staged.naturalKey,
            JSON.stringify({
              candidateCount: match.candidates.length,
              candidateTransactionIds: match.candidates.map((candidate) => candidate.id),
              candidates: match.candidates.map((candidate) => candidate.identity),
            }),
            JSON.stringify({
              ...sheetSourceIdentity(parsed),
              sourceRowNumber: staged.sourceRowNumber,
            }),
            `This source row matches ${match.candidates.length} existing transactions with the same identity. ` +
              "It was NOT assigned or applied automatically; clarify the source identity before changing a transaction.",
          ],
        );
        changedCount++;
        continue;
      }
      const target = match.target;
      const audited = await isTransactionAudited(pool, target.id);

      await pool.query(
        `INSERT INTO sheet_sync_conflicts
           (run_id, payroll_transaction_id, type, audited, natural_key, previous, incoming, detail, status)
         VALUES ($1,$2,'changed',$3,$4,$5::jsonb,$6::jsonb,$7,'open')`,
        [
          runId,
          target.id,
          audited,
          staged.naturalKey,
          JSON.stringify(target.identity),
          JSON.stringify(sheetSourceIdentity(parsed)),
          audited
            ? "The sheet changed a transaction that has an audited manual correction. It was NOT overwritten."
            : "The sheet changed an existing transaction's hours, rate or amount. Review and apply.",
        ],
      );
      await pool.query(
        `UPDATE payroll_transactions SET sync_review_reason = 'source_changed', updated_at = now() WHERE id = $1`,
        [target.id],
      );
      await pool.query(
        `INSERT INTO sheet_sync_rows
           (natural_key, fingerprint, source_row_number, payroll_transaction_id, identity, state,
            first_seen_run_id, last_seen_run_id, last_seen_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,'conflict',$6,$6, now())
         ON CONFLICT (payroll_transaction_id) DO UPDATE
           SET source_row_number = EXCLUDED.source_row_number,
               state = 'conflict', last_seen_run_id = $6, last_seen_at = now(), updated_at = now()`,
        [target.naturalKey, target.fingerprint, staged.sourceRowNumber, target.id, JSON.stringify(target.identity), runId],
      );
      changedCount++;
    }

    // 9. MISSING detection — a previously-synced identity absent from the sheet.
    //    Never deleted; flagged for review.
    const { rows: tracked } = await pool.query<{
      id: string;
      payroll_transaction_id: string;
      natural_key: string;
      fingerprint: string;
    }>(
      `SELECT id, payroll_transaction_id, natural_key, fingerprint FROM sheet_sync_rows
        WHERE state IN ('active','conflict') AND payroll_transaction_id IS NOT NULL`,
    );
    let missingCount = 0;
    for (const row of tracked) {
      const presence = classifyTrackedSourcePresence(
        { fingerprint: row.fingerprint, naturalKey: row.natural_key },
        { fingerprints: snapshotFingerprints, changedNaturalKeys },
      );
      if (presence !== "missing") continue;
      await pool.query(`UPDATE sheet_sync_rows SET state = 'missing', updated_at = now() WHERE id = $1`, [row.id]);
      await pool.query(
        `UPDATE payroll_transactions SET sync_review_reason = 'source_missing', updated_at = now() WHERE id = $1`,
        [row.payroll_transaction_id],
      );
      const { rows: openMissing } = await pool.query<{ c: string }>(
        `SELECT count(*)::text c FROM sheet_sync_conflicts
          WHERE payroll_transaction_id = $1 AND type = 'missing' AND status = 'open'`,
        [row.payroll_transaction_id],
      );
      if (Number(openMissing[0]?.c ?? 0) === 0) {
        await pool.query(
          `INSERT INTO sheet_sync_conflicts
             (run_id, sync_row_id, payroll_transaction_id, type, natural_key, detail, status)
           VALUES ($1,$2,$3,'missing',$4,$5,'open')`,
          [
            runId,
            row.id,
            row.payroll_transaction_id,
            row.natural_key,
            "This transaction's source row is no longer in the sheet. It was NOT deleted; review it.",
          ],
        );
        missingCount++;
      }
    }

    const flagged = changedCount + missingCount;
    let scheduleMatching = noScheduleMatchingNeeded();
    const starts: string[] = [];
    const ends: string[] = [];
    for (const staged of staging.rows) {
      if (!staged.fingerprint || !newTxnByFingerprint.has(staged.fingerprint)) continue;
      const parsed = parsedByRow.get(staged.sourceRowNumber)?.parsed;
      if (!parsed) continue;
      const from = parsed.periodBegin || parsed.checkDate || parsed.periodEnd;
      const to = parsed.periodEnd || parsed.checkDate || parsed.periodBegin;
      if (from) starts.push(from);
      if (to) ends.push(to);
    }
    starts.sort();
    ends.sort();
    const from = starts[0] ?? null;
    const to = ends.at(-1) ?? null;
    if (from && to) {
      scheduleMatching = await attemptOptionalScheduleMatching(
        { from, to },
        () => autoReconcile(pool, { from, to }, opts.userId),
      );
    }
    const syncReconciliation = {
      ...staging.reconciliation,
      note: `${staging.reconciliation.note} ${scheduleMatchingNote(scheduleMatching)}`,
      scheduleMatching,
    };
    base.reconciliation = syncReconciliation;
    await finishRun(pool, runId, {
      status: "success",
      sourceRows: parsedRows.length,
      added,
      updated: 0,
      skipped: unchangedCount,
      flagged,
      failed: invalidCount,
      importBatchId: commitResult.importBatchId,
      reconciliation: syncReconciliation,
    });

    await recordChange(pool, {
      actorId: opts.userId,
      action: "sheet_sync_completed",
      entityType: "sheet_sync_run",
      entityId: runId,
      extra: {
        added,
        skipped: unchangedCount,
        changed: changedCount,
        missing: missingCount,
        failed: invalidCount,
        scheduleMatched: scheduleMatching.matched,
        scheduleConsidered: scheduleMatching.considered,
        scheduleMatchingStatus: scheduleMatching.status,
      },
    });

    const note =
      `${added} added, ${unchangedCount} unchanged` +
      (changedCount ? `, ${changedCount} changed flagged for review` : "") +
      (missingCount ? `, ${missingCount} missing flagged for review` : "") +
      (invalidCount ? `, ${invalidCount} could not be parsed` : "") +
      (paidMarked ? `, ${paidMarked} newly marked paid from the sheet` : "") +
      ". " +
      syncReconciliation.note;

    return {
      ...base,
      status: "success",
      sourceRows: parsedRows.length,
      added,
      skipped: unchangedCount,
      flagged,
      failed: invalidCount,
      changed: changedCount,
      missing: missingCount,
      importBatchId: commitResult.importBatchId,
      reconciliation: syncReconciliation,
      note,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error during sync.";
    await finishRun(pool, runId, { status: "failed", error: message }).catch(() => undefined);
    await recordChange(pool, {
      actorId: opts.userId,
      action: "sheet_sync_failed",
      entityType: "sheet_sync_run",
      entityId: runId,
      extra: { message },
    }).catch(() => undefined);
    return { ...base, status: "failed", error: message, note: `Sync failed: ${message}` };
  }
}
