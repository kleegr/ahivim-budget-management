import type { PgLikePool } from "@/lib/import/commit";
import { commitStagedImport } from "@/lib/import/commit";
import { stageAgainstDatabase } from "@/lib/import/pipeline";
import { currentRatesByProgram } from "@/lib/data/queries";
import type { StagingResult, StagedRow } from "@/lib/import/stage";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";
import { transactionNaturalKey, type TransactionIdentity } from "@/lib/business/fingerprint";
import { recordChange } from "@/lib/manage/audit";
import { parseSheetCsv } from "./parse-csv";
import { isPaidCell } from "@/lib/excel/column-map";
import { fetchSheetCsv, type CsvFetcher, SheetFetchError } from "./fetch";
import { getSyncConfig, type SheetSyncConfig } from "./config";

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
  reconciliation: StagingResult["reconciliation"] | null;
  error: string | null;
  note: string;
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

function incomingIdentity(parsed: ParsedAhivimRow): Record<string, string | null> {
  const p = parsed.parsed;
  if (!p) return { raw: JSON.stringify(parsed.raw) };
  return {
    checkNumber: p.checkNumber || null,
    checkDate: p.checkDate || null,
    program: p.programDescription,
    individual: p.individual,
    employee: p.employee || null,
    periodBegin: p.periodBegin || null,
    periodEnd: p.periodEnd || null,
    hours: p.hours,
    rate: p.rate,
    amount: p.amount,
  };
}

async function lastSuccessfulSnapshot(pool: PgLikePool, excludeRunId: string): Promise<string | null> {
  const { rows } = await pool.query<{ snapshot_sha256: string | null }>(
    `SELECT snapshot_sha256 FROM sheet_sync_runs
      WHERE status IN ('success','no_changes') AND id <> $1 AND snapshot_sha256 IS NOT NULL
      ORDER BY started_at DESC LIMIT 1`,
    [excludeRunId],
  );
  return rows[0]?.snapshot_sha256 ?? null;
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
    const priorSnapshot = await lastSuccessfulSnapshot(pool, runId);
    if (priorSnapshot && priorSnapshot === parse.snapshotSha256) {
      await finishRun(pool, runId, {
        status: "no_changes",
        sourceRows: parsedRows.length,
        added: 0,
        updated: 0,
        skipped: parsedRows.length,
        flagged: 0,
        failed: 0,
        reconciliation: { note: "Sheet unchanged since the last successful sync." },
      });
      return {
        ...base,
        status: "no_changes",
        skipped: parsedRows.length,
        note: "The sheet is unchanged since the last successful sync; nothing was imported.",
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
    const snapshotNaturalKeys = new Set<string>();
    let unchangedCount = 0;
    let invalidCount = 0;

    for (const st of staging.rows) {
      if (st.status === "invalid" || !st.fingerprint || !st.naturalKey) {
        invalidCount++;
        continue;
      }
      snapshotNaturalKeys.add(st.naturalKey);

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
      { naturalKey: string; fingerprint: string; sourceRowNumber: number; identity: string; wasUnchanged: boolean }
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
      // De-dup by transaction id: two identical sheet rows share a fingerprint
      // and would otherwise hit the same ON CONFLICT target twice in one insert.
      trackByTxn.set(txnId, {
        naturalKey: st.naturalKey,
        fingerprint: st.fingerprint,
        sourceRowNumber: st.sourceRowNumber,
        identity: JSON.stringify(parsed ? incomingIdentity(parsed) : {}),
        wasUnchanged,
      });
    }

    const activeTxnIds = [...trackByTxn.keys()];
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
               identity = EXCLUDED.identity,
               state = 'active',
               last_seen_run_id = EXCLUDED.last_seen_run_id,
               last_seen_at = now(),
               updated_at = now()`,
        [
          slice.map(([, v]) => v.naturalKey),
          slice.map(([, v]) => v.fingerprint),
          slice.map(([, v]) => v.sourceRowNumber),
          slice.map(([txn]) => txn),
          slice.map(([, v]) => v.identity),
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
        const parsed = parsedByRow.get(v.sourceRowNumber)?.parsed;
        if (isPaidCell(parsed?.paid)) paidIds.push(txnId);
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
    let changedCount = 0;
    for (const { staged, parsed } of changed) {
      const ledgerTxns = ledger.byNaturalKey.get(staged.naturalKey!) ?? [];
      const target = ledgerTxns[0] ?? null;
      if (!target) continue;
      const audited = await isTransactionAudited(pool, target.id);

      // Keep a single open changed-conflict per transaction, reflecting the latest snapshot.
      await pool.query(
        `UPDATE sheet_sync_conflicts SET status = 'superseded', updated_at = now()
          WHERE payroll_transaction_id = $1 AND type = 'changed' AND status = 'open'`,
        [target.id],
      );
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
          JSON.stringify(incomingIdentity(parsed)),
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
           SET state = 'conflict', last_seen_run_id = $6, last_seen_at = now(), updated_at = now()`,
        [target.naturalKey, target.fingerprint, staged.sourceRowNumber, target.id, JSON.stringify(target.identity), runId],
      );
      changedCount++;
    }

    // 9. MISSING detection — a previously-synced identity absent from the sheet.
    //    Never deleted; flagged for review.
    const { rows: tracked } = await pool.query<{ id: string; payroll_transaction_id: string; natural_key: string }>(
      `SELECT id, payroll_transaction_id, natural_key FROM sheet_sync_rows
        WHERE state IN ('active','conflict') AND payroll_transaction_id IS NOT NULL`,
    );
    let missingCount = 0;
    for (const row of tracked) {
      if (snapshotNaturalKeys.has(row.natural_key)) continue; // still present (possibly as a change)
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
    await finishRun(pool, runId, {
      status: "success",
      sourceRows: parsedRows.length,
      added,
      updated: 0,
      skipped: unchangedCount,
      flagged,
      failed: invalidCount,
      importBatchId: commitResult.importBatchId,
      reconciliation: staging.reconciliation,
    });

    await recordChange(pool, {
      actorId: opts.userId,
      action: "sheet_sync_completed",
      entityType: "sheet_sync_run",
      entityId: runId,
      extra: { added, skipped: unchangedCount, changed: changedCount, missing: missingCount, failed: invalidCount },
    });

    const note =
      `${added} added, ${unchangedCount} unchanged` +
      (changedCount ? `, ${changedCount} changed flagged for review` : "") +
      (missingCount ? `, ${missingCount} missing flagged for review` : "") +
      (invalidCount ? `, ${invalidCount} could not be parsed` : "") +
      (paidMarked ? `, ${paidMarked} newly marked paid from the sheet` : "") +
      ". " +
      staging.reconciliation.note;

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
      reconciliation: staging.reconciliation,
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
