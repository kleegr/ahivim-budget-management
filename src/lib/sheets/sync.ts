import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { commitStagedImport } from "@/lib/import/commit";
import { stageAgainstDatabase } from "@/lib/import/pipeline";
import { currentRatesByProgram } from "@/lib/data/queries";
import {
  holdPartialMultiPersonGroups,
  type AtomicGroupHold,
  type StagingResult,
  type StagedRow,
} from "@/lib/import/stage";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";
import { transactionNaturalKey, type TransactionIdentity } from "@/lib/business/fingerprint";
import { recordChange } from "@/lib/manage/audit";
import { parseSheetCsv, type SheetCsvParseResult } from "./parse-csv";
import { fetchSheetCsv, type CsvFetcher, SheetFetchError } from "./fetch";
import { getSyncConfig, type SheetSyncConfig } from "./config";
import {
  sheetSourceIdentity,
  sourceEvidenceKey,
  SOURCE_EVIDENCE_CONFLICT_MARKER,
  SOURCE_EVIDENCE_KEY_VERSION,
} from "./identity";
import { autoReconcile } from "@/lib/manage/reconciliation";

/**
 * SHEET SYNC ENGINE
 * =================
 *
 * The Google Sheet is the permanent read-only source for imported transaction
 * evidence. Application-owned fields such as Paid remain in Neon. A sync
 * fetches the sheet, maps it into the SAME parsed-row shape the workbook
 * importer produces, and drives it through the SAME staging + commit pipeline,
 * so matching, attribution, group detection, rate logic, reconciliation,
 * fingerprint de-duplication and audit are all inherited unchanged.
 *
 * On top of the pipeline the engine adds exactly what daily syncing needs, and
 * nothing more:
 *
 *   • NEW rows (identity never seen in the ledger) → imported as transactions.
 *   • REPEATED rows (same fingerprint later in one Sheet snapshot) → the
 *     source occurrence is preserved as import evidence, but only one canonical
 *     transaction is inserted.
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
    sheetControlAudit?: SheetControlAudit;
    sourceTrackingVersion?: string;
    pendingAtomicGroupHolds?: AtomicGroupHold[];
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
const SHEET_SYNC_ADVISORY_LOCK = "ahivim:sheet-sync:canonical-ledger:v1";
const SHEET_SYNC_LOCK_WAIT_MS = 120_000;
const SHEET_SYNC_LOCK_POLL_MS = 250;
const SHEET_SYNC_SOURCE_TRACKING_VERSION = "occurrence-v1+source-evidence-v2+unknown-net-review-v1";

function heldNewSourceClaimKey(naturalKey: string, fingerprint: string): string {
  return JSON.stringify([naturalKey, fingerprint]);
}

async function acquireSheetSyncLock(pool: PgLikePool): Promise<PgLikeClient> {
  const deadline = Date.now() + SHEET_SYNC_LOCK_WAIT_MS;
  while (true) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      // Transaction-pinned advisory locks are safe through Neon/PgBouncer
      // transaction-pooling endpoints. A session lock could be stranded on a
      // different backend when the client is returned to the pool.
      await client.query("BEGIN");
      transactionOpen = true;
      const { rows } = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired`,
        [SHEET_SYNC_ADVISORY_LOCK],
      );
      if (rows[0]?.acquired === true) return client;
      await client.query("ROLLBACK");
      transactionOpen = false;
    } catch (error) {
      let destroyConnection = false;
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroyConnection = true;
        }
      }
      client.release(destroyConnection ? true : error instanceof Error ? error : true);
      throw error;
    }
    client.release();

    if (Date.now() >= deadline) {
      throw new Error(
        "Another Google Sheet sync is still running. This run stopped without changing transactions; retry after the active sync finishes.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, SHEET_SYNC_LOCK_POLL_MS));
  }
}

interface SheetControlAudit {
  rawControlTotals: SheetCsvParseResult["rawControlTotals"];
  controlTotalEvidence: SheetCsvParseResult["controlTotalEvidence"];
}

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

function sheetControlScopeNote(
  evidence: SheetCsvParseResult["controlTotalEvidence"],
): string | null {
  const controls = [
    { cell: "P1", column: "P", evidence: evidence.internalAmount },
    { cell: "Q1", column: "G", evidence: evidence.agencyGross },
  ] as const;
  const reasons: string[] = [];

  for (const control of controls) {
    if (control.evidence.status === "scoped_or_mismatched") {
      reasons.push(
        `${control.cell} (${control.evidence.supplied}) was excluded from whole-Sheet reconciliation because ` +
          `all parsed column ${control.column} source rows total ${control.evidence.allRowsTotal}; ` +
          "the displayed control may be filtered or otherwise partial",
      );
    } else if (control.evidence.status === "unverified") {
      reasons.push(
        `${control.cell} (${control.evidence.supplied}) was excluded from whole-Sheet reconciliation because ` +
          `column ${control.column} contains a nonblank, nonnumeric source value, so its all-row total cannot be proved`,
      );
    } else if (control.evidence.status === "invalid_control") {
      reasons.push(
        `${control.cell} contained a nonnumeric or spreadsheet-error control and was excluded from ` +
          "whole-Sheet reconciliation",
      );
    }
  }

  if (reasons.length === 0) return null;
  return `Sheet control scope: ${reasons.join("; ")}. Raw displayed controls were preserved for audit.`;
}

interface LedgerTxn {
  id: string;
  fingerprint: string;
  trackingFingerprint: string | null;
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
    payTo: string | null;
    totalNetPay: string | null;
  };
}

interface Ledger {
  fingerprints: Set<string>;
  naturalKeys: Set<string>;
  byFingerprint: Map<string, LedgerTxn[]>;
  /** Source fingerprints explicitly accepted while retaining canonical Neon values. */
  byAcceptedSourceFingerprint: Map<string, LedgerTxn[]>;
  byNaturalKey: Map<string, LedgerTxn[]>;
}

function classifyExactSourceLedgerMatch(ledger: Ledger, fingerprint: string): ChangedLedgerMatch<LedgerTxn> {
  const candidates = new Map<string, LedgerTxn>();
  for (const candidate of ledger.byFingerprint.get(fingerprint) ?? []) candidates.set(candidate.id, candidate);
  for (const candidate of ledger.byAcceptedSourceFingerprint.get(fingerprint) ?? []) {
    candidates.set(candidate.id, candidate);
  }
  const all = [...candidates.values()];
  if (all.length === 0) return { kind: "missing" };

  // A prior explicit tracking claim can disambiguate an otherwise untracked
  // canonical collision. Two explicit claims are themselves ambiguous: one
  // physical source row must never support two canonical transactions.
  const explicitlyTracked = all.filter((candidate) => candidate.trackingFingerprint === fingerprint);
  if (explicitlyTracked.length === 1) return { kind: "single", target: explicitlyTracked[0]! };
  if (explicitlyTracked.length > 1) return { kind: "ambiguous", candidates: explicitlyTracked };
  return all.length === 1
    ? { kind: "single", target: all[0]! }
    : { kind: "ambiguous", candidates: all };
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

export interface SourceOccurrenceEvidence {
  sourceOccurrenceCount: number;
  sourceRowNumbers: number[];
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Stable physical-source evidence: row order may change, but multiplicity may not vanish silently. */
export function sourceOccurrenceEvidence(sourceRowNumbers: readonly number[]): SourceOccurrenceEvidence {
  const rows = [...new Set(sourceRowNumbers.filter((row) => Number.isSafeInteger(row) && row > 0))]
    .sort((a, b) => a - b);
  return { sourceOccurrenceCount: rows.length, sourceRowNumbers: rows };
}

/** Reads current evidence and remains compatible with legacy tracking identities that stored one row only. */
export function sourceOccurrenceEvidenceFromIdentity(
  identity: unknown,
  fallbackSourceRowNumber: number | null,
): SourceOccurrenceEvidence {
  const record = jsonRecord(identity);
  const storedRows = Array.isArray(record.sourceRowNumbers)
    ? record.sourceRowNumbers.map(positiveInteger).filter((row): row is number => row !== null)
    : [];
  const fallbackRow = positiveInteger(fallbackSourceRowNumber);
  if (storedRows.length === 0 && fallbackRow !== null) storedRows.push(fallbackRow);
  const evidence = sourceOccurrenceEvidence(storedRows);
  const storedCount = positiveInteger(record.sourceOccurrenceCount);
  return {
    sourceOccurrenceCount: Math.max(storedCount ?? 1, evidence.sourceOccurrenceCount),
    sourceRowNumbers: evidence.sourceRowNumbers,
  };
}

export function sourceOccurrenceDeficit(
  expected: SourceOccurrenceEvidence,
  current: SourceOccurrenceEvidence,
): number {
  return Math.max(0, expected.sourceOccurrenceCount - current.sourceOccurrenceCount);
}

export interface StoredSourceEvidence {
  explicit: boolean;
  version: string | null;
  keys: string[];
}

export type SourceEvidenceTransition =
  | { kind: "bootstrap" | "unchanged"; reason: null; expectedKeys: string[]; currentKeys: string[] }
  | { kind: "conflict" | "restored"; reason: "changed" | "variants"; expectedKeys: string[]; currentKeys: string[] };

export function normalizedSourceEvidenceKeys(keys: readonly unknown[]): string[] {
  return [...new Set(keys
    .filter((key): key is string => typeof key === "string" && key.trim().length > 0)
    .map((key) => key.trim()))]
    .sort((a, b) => a.localeCompare(b));
}

export function storedSourceEvidence(identity: unknown): StoredSourceEvidence {
  const record = jsonRecord(identity);
  const version = typeof record.sourceEvidenceKeyVersion === "string"
    ? record.sourceEvidenceKeyVersion
    : null;
  return {
    explicit: version === SOURCE_EVIDENCE_KEY_VERSION && Array.isArray(record.sourceEvidenceKeys),
    version,
    keys: Array.isArray(record.sourceEvidenceKeys)
      ? normalizedSourceEvidenceKeys(record.sourceEvidenceKeys)
      : [],
  };
}

function sameSourceEvidenceKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/**
 * Classifies routing/net evidence independently from the canonical fingerprint.
 * A legacy tracking row gets one silent bootstrap; an existing open conflict
 * retains its original baseline until that exact evidence is restored.
 */
export function classifySourceEvidenceTransition(input: {
  hasPreviousTracking: boolean;
  previousIdentity: unknown;
  currentKeys: readonly string[];
  openConflictPrevious?: unknown;
}): SourceEvidenceTransition {
  const currentKeys = normalizedSourceEvidenceKeys(input.currentKeys);
  const openPrevious = jsonRecord(input.openConflictPrevious);
  const hasOpenEvidenceConflict = openPrevious.sourceEvidenceConflict === SOURCE_EVIDENCE_CONFLICT_MARKER;
  if (hasOpenEvidenceConflict) {
    const reason = openPrevious.sourceEvidenceConflictReason === "variants" ? "variants" : "changed";
    const expectedKeys = storedSourceEvidence(openPrevious).keys;
    const restored = reason === "variants"
      ? currentKeys.length === 1 && expectedKeys.includes(currentKeys[0]!)
      : sameSourceEvidenceKeys(currentKeys, expectedKeys);
    return { kind: restored ? "restored" : "conflict", reason, expectedKeys, currentKeys };
  }

  const previous = storedSourceEvidence(input.previousIdentity);
  if (currentKeys.length > 1) {
    // Multiple variants are always surfaced once. After an operator explicitly
    // dismisses that exact set, the adopted identical baseline stays quiet;
    // any later change to the set reopens review.
    if (input.hasPreviousTracking && previous.explicit && sameSourceEvidenceKeys(currentKeys, previous.keys)) {
      return { kind: "unchanged", reason: null, expectedKeys: previous.keys, currentKeys };
    }
    const hasBaseline = input.hasPreviousTracking && previous.explicit && previous.keys.length > 0;
    return {
      kind: "conflict",
      reason: hasBaseline ? "changed" : "variants",
      // With no trusted baseline, retain the ambiguous variants so a later
      // singleton only auto-resolves when it is one of the values reviewed.
      expectedKeys: hasBaseline ? previous.keys : currentKeys,
      currentKeys,
    };
  }
  if (input.hasPreviousTracking && !previous.explicit) {
    return { kind: "bootstrap", reason: null, expectedKeys: [], currentKeys };
  }
  if (!input.hasPreviousTracking || currentKeys.length === 0) {
    return { kind: input.hasPreviousTracking ? "unchanged" : "bootstrap", reason: null, expectedKeys: previous.keys, currentKeys };
  }
  if (sameSourceEvidenceKeys(currentKeys, previous.keys)) {
    return { kind: "unchanged", reason: null, expectedKeys: previous.keys, currentKeys };
  }
  return { kind: "conflict", reason: "changed", expectedKeys: previous.keys, currentKeys };
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
    pay_to_raw: string | null;
    total_net_pay: string | null;
    transaction_fingerprint: string;
    tracking_fingerprint: string | null;
    tracking_natural_key: string | null;
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
           t.pay_to_raw,
           t.total_net_pay::text    AS total_net_pay,
           t.transaction_fingerprint,
           tracking.fingerprint       AS tracking_fingerprint,
           tracking.natural_key       AS tracking_natural_key
      FROM payroll_transactions t
      LEFT JOIN programs p    ON p.id = t.program_id
      LEFT JOIN individuals i ON i.id = t.individual_id
      LEFT JOIN employees e   ON e.id = t.employee_id
      LEFT JOIN sheet_sync_rows tracking ON tracking.payroll_transaction_id = t.id
  `);

  const ledger: Ledger = {
    fingerprints: new Set(),
    naturalKeys: new Set(),
    byFingerprint: new Map(),
    byAcceptedSourceFingerprint: new Map(),
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
      trackingFingerprint: r.tracking_fingerprint,
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
        payTo: r.pay_to_raw,
        totalNetPay: r.total_net_pay,
      },
    };
    ledger.fingerprints.add(txn.fingerprint);
    const fingerprints = ledger.byFingerprint.get(txn.fingerprint) ?? [];
    fingerprints.push(txn);
    ledger.byFingerprint.set(txn.fingerprint, fingerprints);
    if (r.tracking_fingerprint && r.tracking_fingerprint !== txn.fingerprint) {
      const accepted = ledger.byAcceptedSourceFingerprint.get(r.tracking_fingerprint) ?? [];
      accepted.push(txn);
      ledger.byAcceptedSourceFingerprint.set(r.tracking_fingerprint, accepted);
    }
    // Approved person merges can change the canonical name while the Sheet
    // keeps its original spelling. Its recorded source key still identifies
    // later changed figures; it must not become a second transaction.
    for (const key of new Set([naturalKey, r.tracking_natural_key].filter((value): value is string => Boolean(value)))) {
      ledger.naturalKeys.add(key);
      const list = ledger.byNaturalKey.get(key) ?? [];
      if (!list.some(candidate => candidate.id === txn.id)) list.push(txn);
      ledger.byNaturalKey.set(key, list);
    }
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
  sourceTrackingVersion: string | null;
  pendingAtomicGroupHoldCount: number;
}

/**
 * A byte-identical source is a true no-op only after the current tracking
 * semantics have processed it. This forces one migration-free bootstrap when
 * occurrence/evidence fields are introduced, even if the Sheet itself did not
 * change between application releases.
 */
export function canSkipVersionedSheetSnapshot(input: {
  previousSha256: string | null;
  previousSourceTrackingVersion: string | null;
  currentSha256: string;
  previousPendingAtomicGroupHolds?: number;
}): boolean {
  return input.previousSha256 === input.currentSha256
    && input.previousSourceTrackingVersion === SHEET_SYNC_SOURCE_TRACKING_VERSION
    && (input.previousPendingAtomicGroupHolds ?? 0) === 0;
}

async function lastSuccessfulSync(pool: PgLikePool, excludeRunId: string): Promise<LastSuccessfulSync | null> {
  const { rows } = await pool.query<{
    snapshot_sha256: string | null;
    schedule_matching: unknown;
    source_tracking_version: string | null;
    pending_atomic_group_hold_count: number;
  }>(
    `SELECT snapshot_sha256,
            reconciliation->'scheduleMatching' AS schedule_matching,
            reconciliation->>'sourceTrackingVersion' AS source_tracking_version,
            CASE
              WHEN jsonb_typeof(reconciliation->'pendingAtomicGroupHolds') = 'array'
                THEN jsonb_array_length(reconciliation->'pendingAtomicGroupHolds')
              ELSE 0
            END AS pending_atomic_group_hold_count
       FROM sheet_sync_runs
      WHERE status IN ('success','no_changes') AND id <> $1 AND snapshot_sha256 IS NOT NULL
      ORDER BY finished_at DESC NULLS LAST, started_at DESC, id DESC LIMIT 1`,
    [excludeRunId],
  );
  const row = rows[0];
  if (!row?.snapshot_sha256) return null;
  return {
    snapshotSha256: row.snapshot_sha256,
    scheduleMatching: storedScheduleMatching(row.schedule_matching),
    sourceTrackingVersion: row.source_tracking_version,
    pendingAtomicGroupHoldCount: row.pending_atomic_group_hold_count,
  };
}

async function hasIncompleteRunAfterLastSuccess(pool: PgLikePool, excludeRunId: string): Promise<boolean> {
  const { rows } = await pool.query<{ pending_recovery: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM sheet_sync_runs failed
        WHERE failed.status IN ('failed','running') AND failed.id <> $1
          AND COALESCE(failed.finished_at, failed.started_at) > COALESCE((
            SELECT max(good.finished_at)
              FROM sheet_sync_runs good
             WHERE good.status IN ('success','no_changes') AND good.id <> $1
          ), '-infinity'::timestamptz)
     ) AS pending_recovery`,
    [excludeRunId],
  );
  return rows[0]?.pending_recovery === true;
}

/**
 * Repair the narrow crash window after the import transaction commits but
 * before Sheet tracking is written. The source file and transaction already
 * contain enough immutable provenance to rebuild one conservative tracking
 * row; the next full pass can then surface absence/change normally.
 */
async function recoverUntrackedSheetTransactions(pool: PgLikePool): Promise<number> {
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
    pay_to_raw: string | null;
    total_net_pay: string | null;
    transaction_fingerprint: string;
    source_row_numbers: number[] | null;
    sync_run_id: string | null;
  }>(`
    SELECT t.id,
           t.check_number,
           t.check_date::text AS check_date,
           e.normalized_name AS employee_key,
           i.normalized_name AS individual_key,
           p.code AS program_code,
           t.period_begin::text AS period_begin,
           t.period_end::text AS period_end,
           t.imported_hours::text AS hours,
           t.imported_rate::text AS rate,
           t.imported_amount::text AS amount,
           t.pay_to_raw,
           t.total_net_pay::text AS total_net_pay,
           t.transaction_fingerprint,
           array_agg(DISTINCT source_row.source_row_number ORDER BY source_row.source_row_number)
             FILTER (WHERE source_row.source_row_number IS NOT NULL) AS source_row_numbers,
           source_run.id AS sync_run_id
      FROM payroll_transactions t
      JOIN imported_files source_file ON source_file.id = t.source_file_id
      LEFT JOIN import_rows source_row
        ON source_row.import_batch_id = t.import_batch_id
       AND source_row.transaction_fingerprint = t.transaction_fingerprint
      LEFT JOIN sheet_sync_runs source_run
        ON source_run.id::text = source_file.sheet_summary->>'syncRunId'
      LEFT JOIN programs p ON p.id = t.program_id
      LEFT JOIN individuals i ON i.id = t.individual_id
      LEFT JOIN employees e ON e.id = t.employee_id
     WHERE source_file.sheet_summary->>'kind' = 'sheet_sync_v1'
       AND NOT EXISTS (
         SELECT 1 FROM sheet_sync_rows tracking WHERE tracking.payroll_transaction_id = t.id
       )
     GROUP BY t.id, e.normalized_name, i.normalized_name, p.code, source_run.id
     ORDER BY t.id
  `);
  if (rows.length === 0) return 0;

  const recovered = rows.map((row) => {
    const sourceRows = sourceOccurrenceEvidence(row.source_row_numbers ?? []);
    const canonical: TransactionIdentity = {
      checkNumber: row.check_number,
      checkDate: row.check_date,
      employeeKey: row.employee_key,
      individualKey: row.individual_key ?? "",
      programKey: row.program_code,
      periodBegin: row.period_begin,
      periodEnd: row.period_end,
      hours: row.hours ?? "0",
      rate: row.rate ?? "0",
      amount: row.amount ?? "0",
    };
    const identity: Record<string, unknown> = {
      checkNumber: row.check_number,
      checkDate: row.check_date,
      employee: row.employee_key,
      individual: row.individual_key,
      program: row.program_code,
      periodBegin: row.period_begin,
      periodEnd: row.period_end,
      hours: row.hours ?? "0",
      rate: row.rate ?? "0",
      amount: row.amount ?? "0",
      payTo: row.pay_to_raw,
      totalNetPay: row.total_net_pay,
      ...sourceRows,
    };
    const evidenceKey = sourceEvidenceKey(identity);
    identity.sourceEvidenceKeyVersion = SOURCE_EVIDENCE_KEY_VERSION;
    identity.sourceEvidenceKeys = normalizedSourceEvidenceKeys(evidenceKey ? [evidenceKey] : []);
    return {
      transactionId: row.id,
      naturalKey: transactionNaturalKey(canonical),
      fingerprint: row.transaction_fingerprint,
      sourceRowNumber: sourceRows.sourceRowNumbers[0] ?? null,
      identity,
      syncRunId: row.sync_run_id,
    };
  });

  const { rowCount } = await pool.query(
    `INSERT INTO sheet_sync_rows
       (natural_key, fingerprint, source_row_number, payroll_transaction_id, identity,
        state, first_seen_run_id, last_seen_run_id, last_seen_at)
     SELECT nk, fp, srn, txn::uuid, ident::jsonb, 'active', run_id::uuid, run_id::uuid, now()
       FROM unnest($1::text[], $2::text[], $3::int[], $4::uuid[], $5::text[], $6::text[])
            AS recovered(nk, fp, srn, txn, ident, run_id)
     ON CONFLICT (payroll_transaction_id) DO NOTHING`,
    [
      recovered.map((row) => row.naturalKey),
      recovered.map((row) => row.fingerprint),
      recovered.map((row) => row.sourceRowNumber),
      recovered.map((row) => row.transactionId),
      recovered.map((row) => JSON.stringify(row.identity)),
      recovered.map((row) => row.syncRunId),
    ],
  );
  return rowCount ?? recovered.length;
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
     VALUES ($1, 'queued', $2) RETURNING id`,
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

  // Fingerprints are deliberately not globally unique because ordinary manual
  // imports may contain legitimate repeated lines. Sheet sync has a stricter
  // canonical identity contract, so every Sheet run is serialized before it
  // stages against the ledger. The dedicated, open PostgreSQL transaction owns
  // this lock while the existing pool performs the work. Contenders use a
  // bounded non-blocking poll and release their connection between attempts,
  // preventing pool starvation and making a long holder a visible failure.
  let syncLockClient: PgLikeClient | null = null;
  let sheetControlAudit: SheetControlAudit | null = null;

  try {
    // Serialize the complete authenticated source read and every downstream
    // decision. Otherwise an older, slow pre-lock fetch could publish stale
    // missing/change reviews after a newer snapshot has already completed.
    syncLockClient = await acquireSheetSyncLock(pool);

    // A run is only "running" once it owns the transaction-scoped lock. Reset
    // started_at at that boundary so a queued contender that later commits and
    // crashes is ordered after the successful holder it followed. Rows left in
    // "queued" by a process that dies while waiting cannot have changed data.
    await pool.query(
      `UPDATE sheet_sync_runs
          SET status = 'running', started_at = now(), finished_at = NULL,
              error_message = NULL
        WHERE id = $1`,
      [runId],
    );

    // 1. Fetch + parse the sheet while this run owns the cross-instance lock.
    const csv = await fetcher(config);
    const parse = parseSheetCsv(csv);
    const parsedRows = parse.ahivimRows;
    const controlScopeNote = sheetControlScopeNote(parse.controlTotalEvidence);
    sheetControlAudit = {
      rawControlTotals: parse.rawControlTotals,
      controlTotalEvidence: parse.controlTotalEvidence,
    };
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

    // Repair any transaction committed by an interrupted prior run before the
    // no-op decision. A failed run after the last success also forces one full
    // reconciliation, even when the source bytes later return to an older hash.
    const recoveredTrackingRows = await recoverUntrackedSheetTransactions(pool);
    const pendingIncompleteRunRecovery = await hasIncompleteRunAfterLastSuccess(pool, runId);

    // 2. No-op fast path: the sheet is byte-for-content identical to the last good run.
    const priorSync = await lastSuccessfulSync(pool, runId);
    if (recoveredTrackingRows === 0 && !pendingIncompleteRunRecovery && canSkipVersionedSheetSnapshot({
      previousSha256: priorSync?.snapshotSha256 ?? null,
      previousSourceTrackingVersion: priorSync?.sourceTrackingVersion ?? null,
      currentSha256: parse.snapshotSha256,
      previousPendingAtomicGroupHolds: priorSync?.pendingAtomicGroupHoldCount ?? 0,
    })) {
      const pendingMatch = priorSync?.scheduleMatching ?? null;
      const scheduleMatching = pendingMatch?.status === "needs_review" && pendingMatch.from && pendingMatch.to
        ? await attemptOptionalScheduleMatching(
            { from: pendingMatch.from, to: pendingMatch.to },
            () => autoReconcile(pool, { from: pendingMatch.from!, to: pendingMatch.to! }, opts.userId),
          )
        : null;
      const reconciliationNote = [
        "Sheet unchanged since the last successful sync.",
        controlScopeNote,
        scheduleMatching ? scheduleMatchingNote(scheduleMatching) : null,
      ].filter((note): note is string => note !== null).join(" ");
      await finishRun(pool, runId, {
        status: "no_changes",
        sourceRows: parsedRows.length,
        added: 0,
        updated: 0,
        skipped: parsedRows.length,
        flagged: 0,
        failed: 0,
        reconciliation: {
          note: reconciliationNote,
          sheetControlAudit,
          sourceTrackingVersion: SHEET_SYNC_SOURCE_TRACKING_VERSION,
          ...(scheduleMatching ? { scheduleMatching } : {}),
        },
      });
      return {
        ...base,
        status: "no_changes",
        skipped: parsedRows.length,
        reconciliation: {
          note: reconciliationNote,
          sheetControlAudit,
          sourceTrackingVersion: SHEET_SYNC_SOURCE_TRACKING_VERSION,
          ...(scheduleMatching ? { scheduleMatching } : {}),
        },
        note: [
          "The sheet is unchanged since the last successful sync; nothing was imported.",
          controlScopeNote,
          scheduleMatching ? scheduleMatchingNote(scheduleMatching) : null,
        ].filter((note): note is string => note !== null).join(" "),
      };
    }

    // 3. Stage against the current database (reuses all business logic).
    const staging = await stageAgainstDatabase(pool, parsedRows, {
      agencyGross: parse.wholeSheetControlTotals.agencyGross,
      internalAmount: parse.wholeSheetControlTotals.internalAmount,
    }, { canonicalizeSourceDuplicates: true });

    // 4. Classify every row against the ledger and hold CHANGED rows out of the commit.
    const ledger = await loadLedger(pool);
    const parsedByRow = new Map<number, ParsedAhivimRow>(parsedRows.map((r) => [r.sourceRowNumber, r]));

    // A held new fingerprint remains a new-source claim even if another held
    // fingerprint with the same coarse natural key is corrected and imported
    // first. Without this durable claim, a later correction of the second
    // fingerprint would be misclassified as a change to the first transaction.
    const { rows: heldNewSourceClaimRows } = await pool.query<{
      natural_key: string;
      source_fingerprint: string;
    }>(
      `SELECT natural_key, incoming->>'sourceFingerprint' AS source_fingerprint
         FROM sheet_sync_conflicts
        WHERE type = 'changed' AND status = 'open'
          AND payroll_transaction_id IS NULL
          AND COALESCE((previous->>'candidateCount')::int, -1) = 0
          AND previous->>'sourceEvidenceConflict' = $1
          AND NULLIF(btrim(incoming->>'sourceFingerprint'), '') IS NOT NULL`,
      [SOURCE_EVIDENCE_CONFLICT_MARKER],
    );
    const heldNewSourceClaims = new Set(heldNewSourceClaimRows.map((row) =>
      heldNewSourceClaimKey(row.natural_key, row.source_fingerprint)));

    type NewSourceEvidenceAmbiguity = {
      fingerprint: string;
      naturalKey: string;
      sourceRowNumbers: number[];
      sourceEvidenceKeys: string[];
      sourceEvidenceVariants: Array<{
        payTo: unknown;
        totalNetPay: unknown;
        sourceRowNumbers: number[];
      }>;
    };
    const newEvidenceGroups = new Map<string, NewSourceEvidenceAmbiguity>();
    for (const staged of staging.rows) {
      if (!staged.fingerprint || !staged.naturalKey || staged.status === "invalid") continue;
      if (classifyExactSourceLedgerMatch(ledger, staged.fingerprint).kind !== "missing") continue;
      const heldNewSourceClaim = heldNewSourceClaims.has(
        heldNewSourceClaimKey(staged.naturalKey, staged.fingerprint),
      );
      if (ledger.naturalKeys.has(staged.naturalKey) && !heldNewSourceClaim) continue;
      const parsed = parsedByRow.get(staged.sourceRowNumber);
      if (!parsed) continue;
      const identity: Record<string, unknown> = { ...sheetSourceIdentity(parsed) };
      const evidenceKey = sourceEvidenceKey(identity);
      if (!evidenceKey) continue;
      const existing = newEvidenceGroups.get(staged.fingerprint);
      const variant = existing?.sourceEvidenceVariants.find((candidate) =>
        sourceEvidenceKey(candidate as Record<string, unknown>) === evidenceKey,
      );
      if (existing) {
        existing.sourceRowNumbers.push(staged.sourceRowNumber);
        existing.sourceEvidenceKeys.push(evidenceKey);
        if (variant) variant.sourceRowNumbers.push(staged.sourceRowNumber);
        else existing.sourceEvidenceVariants.push({
          payTo: "payTo" in identity ? identity.payTo : null,
          totalNetPay: "totalNetPay" in identity ? identity.totalNetPay : null,
          sourceRowNumbers: [staged.sourceRowNumber],
        });
      } else {
        newEvidenceGroups.set(staged.fingerprint, {
          fingerprint: staged.fingerprint,
          naturalKey: staged.naturalKey,
          sourceRowNumbers: [staged.sourceRowNumber],
          sourceEvidenceKeys: [evidenceKey],
          sourceEvidenceVariants: [{
            payTo: "payTo" in identity ? identity.payTo : null,
            totalNetPay: "totalNetPay" in identity ? identity.totalNetPay : null,
            sourceRowNumbers: [staged.sourceRowNumber],
          }],
        });
      }
    }
    const newSourceEvidenceAmbiguities = [...newEvidenceGroups.values()]
      .map((group) => ({
        ...group,
        sourceRowNumbers: sourceOccurrenceEvidence(group.sourceRowNumbers).sourceRowNumbers,
        sourceEvidenceKeys: normalizedSourceEvidenceKeys(group.sourceEvidenceKeys),
        sourceEvidenceVariants: group.sourceEvidenceVariants
          .map((variant) => ({
            ...variant,
            sourceRowNumbers: sourceOccurrenceEvidence(variant.sourceRowNumbers).sourceRowNumbers,
          }))
          .sort((left, right) => left.sourceRowNumbers[0]! - right.sourceRowNumbers[0]!),
      }))
      .filter((group) => group.sourceEvidenceKeys.length > 1);
    const newSourceEvidenceAmbiguityRowNumbers = new Set(
      newSourceEvidenceAmbiguities.flatMap((group) => group.sourceRowNumbers),
    );
    for (const staged of staging.rows) {
      if (newSourceEvidenceAmbiguityRowNumbers.has(staged.sourceRowNumber)) {
        // Neither physical variant is authoritative. Holding every occurrence
        // before commit makes the outcome independent of Sheet row order.
        staged.status = "needs_review";
      }
    }

    const changed: { staged: StagedRow; parsed: ParsedAhivimRow }[] = [];
    const exactClaimsByTxn = new Map<string, {
      target: LedgerTxn;
      rows: Array<{ staged: StagedRow; parsed: ParsedAhivimRow }>;
      fingerprints: Set<string>;
    }>();
    const snapshotFingerprints = new Set<string>();
    const seenSourceFingerprints = new Set<string>();
    let unchangedCount = 0;
    let sourceDuplicateCount = 0;
    let invalidCount = 0;

    for (const st of staging.rows) {
      if (st.status === "invalid" || !st.fingerprint || !st.naturalKey) {
        invalidCount++;
        continue;
      }
      const repeatedInSource = seenSourceFingerprints.has(st.fingerprint);
      seenSourceFingerprints.add(st.fingerprint);
      snapshotFingerprints.add(st.fingerprint);

      if (newSourceEvidenceAmbiguityRowNumbers.has(st.sourceRowNumber)) {
        continue;
      }

      if (repeatedInSource && st.status === "duplicate") {
        sourceDuplicateCount++;
        continue; // preserved in import_rows, never inserted into the canonical ledger
      }
      const exactSourceMatch = classifyExactSourceLedgerMatch(ledger, st.fingerprint);
      if (exactSourceMatch.kind === "ambiguous") {
        // The schema permits exact duplicate canonical transactions. Never
        // attach one Sheet row to an arbitrary candidate or silently report a
        // clean sync while the ledger may be doubled; hold one explicit,
        // non-applicable ambiguity review instead.
        st.status = "needs_review";
        const parsed = parsedByRow.get(st.sourceRowNumber);
        if (parsed) changed.push({ staged: st, parsed });
        continue;
      }
      if (exactSourceMatch.kind === "single") {
        // A dismissed canonical change records the accepted source fingerprint
        // in tracking while intentionally retaining different Neon values.
        // Neutralize the staged row so it cannot be inserted as a second
        // transaction and so the acknowledged source state stays quiet.
        if (exactSourceMatch.target.fingerprint !== st.fingerprint) st.status = "duplicate";
        const parsed = parsedByRow.get(st.sourceRowNumber);
        if (parsed) {
          const claim = exactClaimsByTxn.get(exactSourceMatch.target.id) ?? {
            target: exactSourceMatch.target,
            rows: [],
            fingerprints: new Set<string>(),
          };
          claim.rows.push({ staged: st, parsed });
          claim.fingerprints.add(st.fingerprint);
          exactClaimsByTxn.set(exactSourceMatch.target.id, claim);
        }
        unchangedCount++;
        continue; // pipeline will treat this as a confirmed duplicate: not re-imported
      }
      if (heldNewSourceClaims.has(heldNewSourceClaimKey(st.naturalKey, st.fingerprint))) {
        // This exact identity was previously held before any canonical row was
        // selected. It stays independently importable after a sibling identity
        // with the same natural key is restored first.
        continue;
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

    // One canonical transaction may have an explicitly accepted source
    // fingerprint different from its Neon fingerprint. If both distinct rows
    // later appear together, they are not exact repeats and cannot both be
    // represented by that one transaction. Hold the group for explicit source
    // repair instead of letting input order select one fingerprint silently.
    const canonicalSourceAmbiguities = [...exactClaimsByTxn.values()]
      .filter((claim) => claim.fingerprints.size > 1)
      .map((claim) => {
        for (const row of claim.rows) row.staged.status = "needs_review";
        unchangedCount -= claim.rows.length;
        return claim;
      });
    const canonicalAmbiguityRowNumbers = new Set<number>();
    for (const ambiguity of canonicalSourceAmbiguities) {
      for (const staged of staging.rows) {
        if (
          staged.naturalKey === ambiguity.target.naturalKey
          && staged.fingerprint
          && ambiguity.fingerprints.has(staged.fingerprint)
        ) canonicalAmbiguityRowNumbers.add(staged.sourceRowNumber);
      }
    }

    // A detected multi-person service is atomic. When one member is already in
    // the ledger or otherwise held, hold every still-new member before commit;
    // otherwise commit would create a partial transaction/session/allocation.
    const atomicGroupHolds = holdPartialMultiPersonGroups(staging);

    // Resolve changed-row candidates once and reuse that exact decision for
    // source-evidence classification and conflict creation. An ambiguous
    // natural key remains intentionally unassociated.
    const changedMatchBySourceRow = new Map<number, ChangedLedgerMatch<LedgerTxn>>();
    const changedMatchByFingerprint = new Map<string, ChangedLedgerMatch<LedgerTxn>>();
    for (const { staged } of changed) {
      const match = classifyChangedLedgerMatch(ledger.byNaturalKey.get(staged.naturalKey!) ?? []);
      changedMatchBySourceRow.set(staged.sourceRowNumber, match);
      changedMatchByFingerprint.set(staged.fingerprint!, match);
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
        rawControlTotals: parse.rawControlTotals,
        controlTotalEvidence: parse.controlTotalEvidence,
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
    const changedRowNumbers = new Set([
      ...changed.map((c) => c.staged.sourceRowNumber),
      ...canonicalAmbiguityRowNumbers,
    ]);
    const trackByTxn = new Map<
      string,
      {
        naturalKey: string;
        fingerprint: string;
        sourceRowNumber: number;
        sourceRowNumbers: number[];
        sourceEvidenceKeys: string[];
        identity: Record<string, unknown>;
        sourcePaid: boolean;
        wasUnchanged: boolean;
      }
    >();
    for (const st of staging.rows) {
      if (!st.fingerprint || !st.naturalKey) continue;
      if (changedRowNumbers.has(st.sourceRowNumber)) continue;

      const exactSourceMatch = classifyExactSourceLedgerMatch(ledger, st.fingerprint);
      const wasUnchanged = exactSourceMatch.kind === "single";
      const txnId = wasUnchanged
        ? exactSourceMatch.target.id
        : newTxnByFingerprint.get(st.fingerprint) ?? null;
      if (!txnId) continue; // a genuinely-new row that stayed in review (e.g. unknown program): no transaction yet

      const parsed = parsedByRow.get(st.sourceRowNumber);
      const identity = parsed ? sheetSourceIdentity(parsed) : {};
      const evidenceKey = sourceEvidenceKey(identity);
      const sourcePaid = "sourcePaid" in identity && identity.sourcePaid === true;
      // De-dup by transaction id: two identical sheet rows share a fingerprint
      // and would otherwise hit the same ON CONFLICT target twice in one insert.
      // Preserve all physical occurrence positions as evidence while retaining
      // exactly one canonical transaction and one tracking row.
      const existing = trackByTxn.get(txnId);
      if (existing) {
        existing.sourceRowNumber = Math.min(existing.sourceRowNumber, st.sourceRowNumber);
        existing.sourceRowNumbers.push(st.sourceRowNumber);
        if (evidenceKey) existing.sourceEvidenceKeys.push(evidenceKey);
        existing.sourcePaid = existing.sourcePaid || sourcePaid;
        existing.identity = { ...existing.identity, sourcePaid: existing.sourcePaid };
        continue;
      }
      trackByTxn.set(txnId, {
        naturalKey: st.naturalKey,
        fingerprint: st.fingerprint,
        sourceRowNumber: st.sourceRowNumber,
        sourceRowNumbers: [st.sourceRowNumber],
        sourceEvidenceKeys: evidenceKey ? [evidenceKey] : [],
        identity,
        sourcePaid,
        wasUnchanged,
      });
    }

    for (const tracked of trackByTxn.values()) {
      const occurrence = sourceOccurrenceEvidence(tracked.sourceRowNumbers);
      tracked.sourceRowNumbers = occurrence.sourceRowNumbers;
      tracked.sourceRowNumber = occurrence.sourceRowNumbers[0] ?? tracked.sourceRowNumber;
      tracked.sourceEvidenceKeys = normalizedSourceEvidenceKeys(tracked.sourceEvidenceKeys);
      tracked.identity = {
        ...tracked.identity,
        ...occurrence,
        sourceEvidenceKeyVersion: SOURCE_EVIDENCE_KEY_VERSION,
        sourceEvidenceKeys: tracked.sourceEvidenceKeys,
      };
    }

    type CurrentSourceEvidence = {
      naturalKey: string;
      identity: Record<string, unknown>;
      sourceRowNumbers: number[];
      sourceFingerprints: string[];
      sourceEvidenceKeys: string[];
      sourceEvidenceVariants: Array<{
        payTo: unknown;
        totalNetPay: unknown;
        sourceRowNumbers: number[];
      }>;
      fallbackPreviousIdentity: Record<string, unknown> | null;
    };
    const currentEvidenceByTxn = new Map<string, CurrentSourceEvidence>();

    // Observe every physical source occurrence, including held canonical
    // changes and exact duplicates. This makes routing/net drift impossible to
    // hide inside an ordinary hours/rate/amount conflict.
    for (const staged of staging.rows) {
      if (!staged.fingerprint || !staged.naturalKey || staged.status === "invalid") continue;
      if (canonicalAmbiguityRowNumbers.has(staged.sourceRowNumber)) continue;
      const parsed = parsedByRow.get(staged.sourceRowNumber);
      if (!parsed) continue;

      const exactSourceMatch = classifyExactSourceLedgerMatch(ledger, staged.fingerprint);
      const unchangedTarget = exactSourceMatch.kind === "single" ? exactSourceMatch.target : null;
      // Exact repeated physical rows are collapsed by staging, but still belong
      // to the same changed target as the first occurrence of their fingerprint.
      const changedMatch = changedMatchBySourceRow.get(staged.sourceRowNumber)
        ?? changedMatchByFingerprint.get(staged.fingerprint);
      const changedTarget = changedMatch?.kind === "single" ? changedMatch.target : null;
      const txnId = unchangedTarget?.id
        ?? changedTarget?.id
        ?? newTxnByFingerprint.get(staged.fingerprint)
        ?? null;
      if (!txnId) continue;

      const identity: Record<string, unknown> = { ...sheetSourceIdentity(parsed) };
      const evidenceKey = sourceEvidenceKey(identity);
      const existing = currentEvidenceByTxn.get(txnId);
      const variant = {
        payTo: "payTo" in identity ? identity.payTo : null,
        totalNetPay: "totalNetPay" in identity ? identity.totalNetPay : null,
        sourceRowNumbers: [staged.sourceRowNumber],
      };
      if (!existing) {
        currentEvidenceByTxn.set(txnId, {
          naturalKey: staged.naturalKey,
          identity,
          sourceRowNumbers: [staged.sourceRowNumber],
          sourceFingerprints: [staged.fingerprint],
          sourceEvidenceKeys: evidenceKey ? [evidenceKey] : [],
          sourceEvidenceVariants: [variant],
          fallbackPreviousIdentity: unchangedTarget?.identity ?? changedTarget?.identity ?? null,
        });
        continue;
      }

      existing.sourceRowNumbers.push(staged.sourceRowNumber);
      existing.sourceFingerprints.push(staged.fingerprint);
      if (evidenceKey) existing.sourceEvidenceKeys.push(evidenceKey);
      const matchingVariant = existing.sourceEvidenceVariants.find((candidate) =>
        sourceEvidenceKey(candidate as Record<string, unknown>) === evidenceKey,
      );
      if (matchingVariant) matchingVariant.sourceRowNumbers.push(staged.sourceRowNumber);
      else existing.sourceEvidenceVariants.push(variant);
      if (!existing.fallbackPreviousIdentity && changedTarget) {
        existing.fallbackPreviousIdentity = changedTarget.identity;
      }
    }

    for (const current of currentEvidenceByTxn.values()) {
      current.sourceRowNumbers = sourceOccurrenceEvidence(current.sourceRowNumbers).sourceRowNumbers;
      current.sourceFingerprints = [...new Set(current.sourceFingerprints)].sort((a, b) => a.localeCompare(b));
      current.sourceEvidenceKeys = normalizedSourceEvidenceKeys(current.sourceEvidenceKeys);
      current.sourceEvidenceVariants = current.sourceEvidenceVariants
        .map((variant) => ({
          ...variant,
          sourceRowNumbers: sourceOccurrenceEvidence(variant.sourceRowNumbers).sourceRowNumbers,
        }))
        .sort((left, right) => left.sourceRowNumbers[0]! - right.sourceRowNumbers[0]!);
      current.identity = {
        ...current.identity,
        sourceRowNumbers: current.sourceRowNumbers,
        sourceOccurrenceCount: current.sourceRowNumbers.length,
        sourceFingerprint: current.sourceFingerprints.length === 1 ? current.sourceFingerprints[0]! : null,
        sourceFingerprints: current.sourceFingerprints,
        sourceEvidenceKeyVersion: SOURCE_EVIDENCE_KEY_VERSION,
        sourceEvidenceKeys: current.sourceEvidenceKeys,
        sourceEvidenceVariants: current.sourceEvidenceVariants,
      };
    }

    const evidenceTxnIds = [...currentEvidenceByTxn.keys()];
    const reviewTxnIds = new Set(evidenceTxnIds);
    type PreviousTrackingRow = {
      id: string;
      payroll_transaction_id: string;
      source_row_number: number | null;
      identity: unknown;
    };
    type OpenMissingConflictRow = {
      id: string;
      payroll_transaction_id: string;
      previous: unknown;
    };
    type OpenSourceEvidenceConflictRow = {
      id: string;
      payroll_transaction_id: string;
      previous: unknown;
    };
    const previousTrackingByTxn = new Map<string, PreviousTrackingRow>();
    const openMissingConflictRows: OpenMissingConflictRow[] = [];
    const openSourceEvidenceConflictRows: OpenSourceEvidenceConflictRow[] = [];
    const recoveredUnknownNetTxnIds = new Set([...currentEvidenceByTxn]
      .filter(([, current]) => current.fallbackPreviousIdentity?.totalNetPay === null
        && current.sourceEvidenceVariants.some(variant => typeof variant.totalNetPay === "string"
          && /^[+-]?\d+(?:\.\d+)?$/.test(variant.totalNetPay)))
      .map(([txnId]) => txnId));
    const acknowledgedEvidenceByTxn = new Map<string, string[][]>();
    if (recoveredUnknownNetTxnIds.size > 0) {
      const { rows: acknowledged } = await pool.query<{
        payroll_transaction_id: string;
        incoming: unknown;
      }>(
        `SELECT payroll_transaction_id, incoming FROM sheet_sync_conflicts
          WHERE payroll_transaction_id = ANY($1::uuid[])
            AND type = 'changed' AND status = 'dismissed'
            AND resolution IN ('source_evidence_adopted', 'source_change_acknowledged')`,
        [[...recoveredUnknownNetTxnIds]],
      );
      for (const row of acknowledged) {
        const evidence = storedSourceEvidence(row.incoming);
        if (!evidence.explicit) continue;
        const prior = acknowledgedEvidenceByTxn.get(row.payroll_transaction_id) ?? [];
        prior.push(evidence.keys);
        acknowledgedEvidenceByTxn.set(row.payroll_transaction_id, prior);
      }
    }
    if (evidenceTxnIds.length > 0) {
      const { rows: previousTrackingRows } = await pool.query<PreviousTrackingRow>(
        `SELECT id, payroll_transaction_id, source_row_number, identity
           FROM sheet_sync_rows
          WHERE payroll_transaction_id = ANY($1::uuid[])`,
        [evidenceTxnIds],
      );
      for (const row of previousTrackingRows) previousTrackingByTxn.set(row.payroll_transaction_id, row);

      const { rows: openEvidenceRows } = await pool.query<OpenSourceEvidenceConflictRow>(
        `SELECT id, payroll_transaction_id, previous
           FROM sheet_sync_conflicts
          WHERE payroll_transaction_id = ANY($1::uuid[])
            AND type = 'changed' AND status = 'open'
            AND previous->>'sourceEvidenceConflict' = $2
          ORDER BY created_at DESC`,
        [evidenceTxnIds, SOURCE_EVIDENCE_CONFLICT_MARKER],
      );
      openSourceEvidenceConflictRows.push(...openEvidenceRows);
    }

    if (evidenceTxnIds.length > 0) {
      const { rows: openMissingRows } = await pool.query<OpenMissingConflictRow>(
        `SELECT id, payroll_transaction_id, previous
           FROM sheet_sync_conflicts
          WHERE payroll_transaction_id = ANY($1::uuid[])
            AND type = 'missing' AND status = 'open'
          ORDER BY created_at DESC`,
        [evidenceTxnIds],
      );
      openMissingConflictRows.push(...openMissingRows);
    }
    let added = 0;
    for (const v of trackByTxn.values()) if (!v.wasUnchanged) added++;

    // The inbound Paid cell remains in identity.sourcePaid as raw evidence.
    // It never updates payroll_transactions.is_paid: that is a Neon-owned
    // application decision changed only through authenticated app workflows.

    // Compare physical source multiplicity against the evidence captured before
    // the upsert. A repeated source occurrence shares one canonical transaction,
    // but a count shrink must still remain visible as one precise missing conflict.
    const openMissingByTxn = new Map<string, OpenMissingConflictRow>();
    for (const conflict of openMissingConflictRows) {
      const stored = openMissingByTxn.get(conflict.payroll_transaction_id);
      const candidateCount = positiveInteger(jsonRecord(conflict.previous).sourceOccurrenceCount) ?? 0;
      const storedCount = stored
        ? positiveInteger(jsonRecord(stored.previous).sourceOccurrenceCount) ?? 0
        : -1;
      if (!stored || candidateCount > storedCount) openMissingByTxn.set(conflict.payroll_transaction_id, conflict);
    }

    let missingCount = 0;
    const occurrenceDeficitTxnIds = new Set<string>();
    for (const [txnId, current] of currentEvidenceByTxn) {
      const previousRow = previousTrackingByTxn.get(txnId);
      const currentEvidence = sourceOccurrenceEvidence(current.sourceRowNumbers);
      const previousEvidence = previousRow
        ? sourceOccurrenceEvidenceFromIdentity(previousRow.identity, previousRow.source_row_number)
        : currentEvidence;
      const openConflict = openMissingByTxn.get(txnId);
      const openExpectedCount = openConflict
        ? positiveInteger(jsonRecord(openConflict.previous).sourceOccurrenceCount)
        : null;
      const expectedCount = Math.max(previousEvidence.sourceOccurrenceCount, openExpectedCount ?? 0);
      const expectedEvidence: SourceOccurrenceEvidence = {
        sourceOccurrenceCount: expectedCount,
        sourceRowNumbers: previousEvidence.sourceRowNumbers,
      };
      const missingOccurrences = sourceOccurrenceDeficit(expectedEvidence, currentEvidence);
      if (missingOccurrences === 0) continue;

      occurrenceDeficitTxnIds.add(txnId);
      const openPrevious = openConflict ? jsonRecord(openConflict.previous) : {};
      const trackedPrevious = previousRow ? jsonRecord(previousRow.identity) : {};
      const baselineIdentity = openExpectedCount !== null
        && openExpectedCount >= previousEvidence.sourceOccurrenceCount
        ? openPrevious
        : trackedPrevious;
      const previousPayload = {
        ...baselineIdentity,
        sourceOccurrenceCount: expectedCount,
        sourceRowNumbers: sourceOccurrenceEvidenceFromIdentity(
          baselineIdentity,
          previousRow?.source_row_number ?? null,
        ).sourceRowNumbers,
      };
      const incomingPayload = { ...current.identity, ...currentEvidence };
      const detail =
        `This exact source group previously had ${expectedCount} occurrence${expectedCount === 1 ? "" : "s"} ` +
        `and now has ${currentEvidence.sourceOccurrenceCount}; ${missingOccurrences} source occurrence` +
        `${missingOccurrences === 1 ? " is" : "s are"} missing. The one canonical transaction was NOT deleted or duplicated; review the occurrence evidence.`;

      if (openConflict) {
        await pool.query(
          `UPDATE sheet_sync_conflicts
              SET run_id = $2, sync_row_id = COALESCE(sync_row_id, $3),
                  previous = $4::jsonb, incoming = $5::jsonb, detail = $6, updated_at = now()
            WHERE id = $1`,
          [
            openConflict.id,
            runId,
            previousRow?.id ?? null,
            JSON.stringify(previousPayload),
            JSON.stringify(incomingPayload),
            detail,
          ],
        );
      } else {
        await pool.query(
          `INSERT INTO sheet_sync_conflicts
             (run_id, sync_row_id, payroll_transaction_id, type, natural_key,
              previous, incoming, detail, status)
           VALUES ($1,$2,$3,'missing',$4,$5::jsonb,$6::jsonb,$7,'open')`,
          [
            runId,
            previousRow?.id ?? null,
            txnId,
            current.naturalKey,
            JSON.stringify(previousPayload),
            JSON.stringify(incomingPayload),
            detail,
          ],
        );
        missingCount++;
      }
    }
    // A whole row that reappears clears its prior missing conflict immediately.
    // An occurrence-count conflict clears only when the expected multiplicity is
    // restored; unrelated source changes and row reordering cannot dismiss it.
    const restoredConflicts = openMissingConflictRows
      .filter((conflict) => {
        const current = currentEvidenceByTxn.get(conflict.payroll_transaction_id);
        if (!current || occurrenceDeficitTxnIds.has(conflict.payroll_transaction_id)) return false;
        const expected = positiveInteger(jsonRecord(conflict.previous).sourceOccurrenceCount);
        return expected === null || current.sourceRowNumbers.length >= expected;
      });
    const restoredConflictIds = restoredConflicts.map((conflict) => conflict.id);
    const restoredOccurrenceConflictIds = restoredConflicts
      .filter((conflict) => (positiveInteger(jsonRecord(conflict.previous).sourceOccurrenceCount) ?? 1) > 1)
      .map((conflict) => conflict.id);
    // Routing and source-net evidence is versioned separately from the canonical
    // transaction fingerprint. Legacy routing can bootstrap, but a recovered
    // numeric NET must not silently become the baseline while canonical NET is
    // still unknown. Explicit acknowledgement remains authoritative.
    const openSourceEvidenceByTxn = new Map<string, OpenSourceEvidenceConflictRow>();
    for (const conflict of openSourceEvidenceConflictRows) {
      if (!openSourceEvidenceByTxn.has(conflict.payroll_transaction_id)) {
        openSourceEvidenceByTxn.set(conflict.payroll_transaction_id, conflict);
      }
    }
    const sourceEvidenceConflictTxnIds = new Set<string>();
    const restoredSourceEvidenceConflictIds: string[] = [];
    let sourceEvidenceChangedCount = 0;
    for (const [txnId, current] of currentEvidenceByTxn) {
      const previousRow = previousTrackingByTxn.get(txnId);
      const openConflict = openSourceEvidenceByTxn.get(txnId);
      let previousIdentity = previousRow?.identity ?? current.fallbackPreviousIdentity;
      const previousEvidence = storedSourceEvidence(previousIdentity);
      const unknownNetNeedsReview = recoveredUnknownNetTxnIds.has(txnId)
        && !openConflict
        && (!previousEvidence.explicit || sameSourceEvidenceKeys(previousEvidence.keys, current.sourceEvidenceKeys))
        && !(acknowledgedEvidenceByTxn.get(txnId) ?? [])
          .some(keys => sameSourceEvidenceKeys(keys, current.sourceEvidenceKeys));
      if (unknownNetNeedsReview) {
        // A previous release may already have advanced tracking without a
        // review. Retain the known canonical NULL, using current routing only
        // to isolate the NET discrepancy rather than guess legacy routing.
        previousIdentity = {
          ...jsonRecord(previousIdentity),
          totalNetPay: null,
          sourceEvidenceKeyVersion: SOURCE_EVIDENCE_KEY_VERSION,
          sourceEvidenceKeys: normalizedSourceEvidenceKeys(current.sourceEvidenceVariants
            .map(variant => sourceEvidenceKey({ ...variant, totalNetPay: null }))),
        };
      }
      const transition = classifySourceEvidenceTransition({
        hasPreviousTracking: previousIdentity !== null && previousIdentity !== undefined,
        previousIdentity,
        currentKeys: current.sourceEvidenceKeys,
        openConflictPrevious: openConflict?.previous,
      });

      if (transition.kind === "restored") {
        if (openConflict) restoredSourceEvidenceConflictIds.push(openConflict.id);
        continue;
      }
      if (transition.kind !== "conflict") continue;

      sourceEvidenceConflictTxnIds.add(txnId);
      const baselineIdentity = openConflict
        ? jsonRecord(openConflict.previous)
        : jsonRecord(previousIdentity);
      const previousPayload = {
        ...baselineIdentity,
        sourceEvidenceConflict: SOURCE_EVIDENCE_CONFLICT_MARKER,
        sourceEvidenceConflictReason: transition.reason,
        sourceEvidenceKeyVersion: SOURCE_EVIDENCE_KEY_VERSION,
        sourceEvidenceKeys: transition.expectedKeys,
      };
      const incomingPayload = {
        ...current.identity,
        sourceEvidenceConflict: SOURCE_EVIDENCE_CONFLICT_MARKER,
        sourceEvidenceConflictReason: transition.reason,
        sourceEvidenceKeyVersion: SOURCE_EVIDENCE_KEY_VERSION,
        sourceEvidenceKeys: transition.currentKeys,
      };
      const detail = transition.reason === "variants"
        ? `This one canonical transaction has ${transition.currentKeys.length} conflicting Pay To or Total Net Pay source-evidence variants. ` +
          "No transaction value was changed automatically; correct or explicitly dismiss the source evidence."
        : "Pay To or Total Net Pay source evidence changed while the canonical transaction fingerprint stayed the same. " +
          "No transaction value was changed automatically; restore, correct, or explicitly dismiss the source evidence.";

      if (openConflict) {
        await pool.query(
          `UPDATE sheet_sync_conflicts
              SET run_id = $2, sync_row_id = COALESCE(sync_row_id, $3),
                  incoming = $4::jsonb, detail = $5, updated_at = now()
            WHERE id = $1`,
          [openConflict.id, runId, previousRow?.id ?? null, JSON.stringify(incomingPayload), detail],
        );
      } else {
        await pool.query(
          `INSERT INTO sheet_sync_conflicts
             (run_id, sync_row_id, payroll_transaction_id, type, audited, natural_key,
              previous, incoming, detail, status)
           VALUES ($1,$2,$3,'changed',false,$4,$5::jsonb,$6::jsonb,$7,'open')`,
          [
            runId,
            previousRow?.id ?? null,
            txnId,
            current.naturalKey,
            JSON.stringify(previousPayload),
            JSON.stringify(incomingPayload),
            detail,
          ],
        );
        sourceEvidenceChangedCount++;
      }
    }
    // Advance the stored tracking baseline only after every occurrence and
    // routing/net conflict above has been durably materialized. If a transient
    // failure happens earlier, a retry still compares against the old baseline
    // and cannot silently absorb the source change.
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
          slice.map(([, v]) => JSON.stringify(v.identity)),
          runId,
        ],
      );
    }

    // Close missing/occurrence restoration only after the recovered current
    // occurrence baseline is durable. If tracking fails, the open conflict
    // retains its prior expected count for an exact retry.
    if (restoredConflictIds.length > 0) {
      await pool.query(
        `UPDATE sheet_sync_conflicts
            SET status = 'dismissed',
                resolution = CASE
                  WHEN id = ANY($2::uuid[]) THEN 'source_occurrence_count_restored'
                  ELSE 'reappeared'
                END,
                resolved_at = now(), updated_at = now()
          WHERE id = ANY($1::uuid[])`,
        [restoredConflictIds, restoredOccurrenceConflictIds],
      );
    }

    // For a restoration, advance the tracking identity before closing the old
    // evidence conflict. A failure between those writes then leaves the open
    // conflict available for an idempotent retry instead of inventing a false
    // reverse-drift conflict against the stale baseline.
    if (restoredSourceEvidenceConflictIds.length > 0) {
      await pool.query(
        `UPDATE sheet_sync_conflicts
            SET status = 'dismissed', resolution = 'source_evidence_restored',
                resolved_at = now(), updated_at = now()
          WHERE id = ANY($1::uuid[])
            AND type = 'changed' AND status = 'open'
            AND previous->>'sourceEvidenceConflict' = $2`,
        [restoredSourceEvidenceConflictIds, SOURCE_EVIDENCE_CONFLICT_MARKER],
      );
    }

    // 8. CHANGED conflicts — never overwrite; flag for review, audited-aware.
    const changedNaturalKeys = new Set([
      ...changed.map((row) => row.staged.naturalKey!).filter(Boolean),
      ...canonicalSourceAmbiguities.map((ambiguity) => ambiguity.target.naturalKey),
      ...newSourceEvidenceAmbiguities.map((ambiguity) => ambiguity.naturalKey),
    ]);
    // Rebuild the open changed set from the current snapshot. Superseding every
    // prior conflict for a still-changed identity before inserting the current
    // rows preserves more than one legitimate changed occurrence with the same
    // coarse natural key, rather than allowing the last row to hide the others.
    await pool.query(
      `UPDATE sheet_sync_conflicts
          SET status = 'superseded', resolution = 'newer_source_snapshot',
              resolved_at = now(), updated_at = now()
        WHERE type = 'changed' AND status = 'open'
          AND COALESCE(previous->>'sourceEvidenceConflict', '') <> $2
          AND natural_key = ANY($1::text[])`,
      [[...changedNaturalKeys], SOURCE_EVIDENCE_CONFLICT_MARKER],
    );
    // A prior change is no longer actionable once its natural key is not
    // changed in the current snapshot (it either reverted or became missing).
    // Missing detection below will open the current, more accurate state.
    await pool.query(
      `UPDATE sheet_sync_conflicts
          SET status = 'dismissed', resolution = 'source_no_longer_changed',
              resolved_at = now(), updated_at = now()
        WHERE type = 'changed' AND status = 'open'
          AND COALESCE(previous->>'sourceEvidenceConflict', '') <> $2
          AND NOT (natural_key = ANY($1::text[]))`,
      [[...changedNaturalKeys], SOURCE_EVIDENCE_CONFLICT_MARKER],
    );

    const currentNewEvidenceFingerprints = newSourceEvidenceAmbiguities.map((ambiguity) => ambiguity.fingerprint);
    await pool.query(
      `UPDATE sheet_sync_conflicts
          SET status = 'dismissed', resolution = 'source_evidence_restored',
              resolved_at = now(), updated_at = now()
        WHERE type = 'changed' AND status = 'open'
          AND payroll_transaction_id IS NULL
          AND COALESCE((previous->>'candidateCount')::int, -1) = 0
          AND previous->>'sourceEvidenceConflict' = $2
          AND NOT (COALESCE(incoming->>'sourceFingerprint', '') = ANY($1::text[]))`,
      [currentNewEvidenceFingerprints, SOURCE_EVIDENCE_CONFLICT_MARKER],
    );

    let changedCount = sourceEvidenceChangedCount;
    for (const ambiguity of newSourceEvidenceAmbiguities) {
      const previousPayload = {
        candidateCount: 0,
        candidateTransactionIds: [],
        sourceEvidenceConflict: SOURCE_EVIDENCE_CONFLICT_MARKER,
        sourceEvidenceConflictReason: "variants",
        sourceEvidenceKeyVersion: SOURCE_EVIDENCE_KEY_VERSION,
        sourceEvidenceKeys: ambiguity.sourceEvidenceKeys,
      };
      const incomingPayload = {
        sourceFingerprint: ambiguity.fingerprint,
        sourceOccurrenceCount: ambiguity.sourceRowNumbers.length,
        sourceRowNumbers: ambiguity.sourceRowNumbers,
        sourceRowNumber: ambiguity.sourceRowNumbers[0] ?? null,
        sourceEvidenceKeyVersion: SOURCE_EVIDENCE_KEY_VERSION,
        sourceEvidenceKeys: ambiguity.sourceEvidenceKeys,
        sourceEvidenceVariants: ambiguity.sourceEvidenceVariants,
      };
      const detail = "A new canonical source identity has conflicting Pay To or Total Net Pay variants. " +
        "Every occurrence was held before import, so no routing or financial value was selected by row order; correct the source evidence and sync again.";
      const { rows: existingRows } = await pool.query<{ id: string }>(
        `SELECT id
           FROM sheet_sync_conflicts
          WHERE type = 'changed' AND status = 'open'
            AND payroll_transaction_id IS NULL AND natural_key = $1
            AND COALESCE((previous->>'candidateCount')::int, -1) = 0
            AND previous->>'sourceEvidenceConflict' = $2
            AND incoming->>'sourceFingerprint' = $3
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [ambiguity.naturalKey, SOURCE_EVIDENCE_CONFLICT_MARKER, ambiguity.fingerprint],
      );
      if (existingRows[0]) {
        await pool.query(
          `UPDATE sheet_sync_conflicts
              SET run_id = $2, previous = $3::jsonb, incoming = $4::jsonb,
                  detail = $5, updated_at = now()
            WHERE id = $1`,
          [existingRows[0].id, runId, JSON.stringify(previousPayload), JSON.stringify(incomingPayload), detail],
        );
      } else {
        await pool.query(
          `INSERT INTO sheet_sync_conflicts
             (run_id, payroll_transaction_id, type, audited, natural_key, previous, incoming, detail, status)
           VALUES ($1,NULL,'changed',false,$2,$3::jsonb,$4::jsonb,$5,'open')`,
          [runId, ambiguity.naturalKey, JSON.stringify(previousPayload), JSON.stringify(incomingPayload), detail],
        );
      }
      changedCount++;
    }
    for (const ambiguity of canonicalSourceAmbiguities) {
      const sourceRows = staging.rows
        .filter((staged) => staged.naturalKey === ambiguity.target.naturalKey
          && staged.fingerprint != null
          && ambiguity.fingerprints.has(staged.fingerprint))
        .map((staged) => staged.sourceRowNumber)
        .sort((a, b) => a - b);
      await pool.query(
        `INSERT INTO sheet_sync_conflicts
           (run_id, payroll_transaction_id, type, audited, natural_key, previous, incoming, detail, status)
         VALUES ($1,NULL,'changed',false,$2,$3::jsonb,$4::jsonb,$5,'open')`,
        [
          runId,
          ambiguity.target.naturalKey,
          JSON.stringify({
            candidateCount: 1,
            candidateTransactionIds: [ambiguity.target.id],
            candidate: ambiguity.target.identity,
          }),
          JSON.stringify({
            canonicalSourceAmbiguity: "multiple_fingerprints_for_one_transaction",
            sourceFingerprints: [...ambiguity.fingerprints].sort((a, b) => a.localeCompare(b)),
            sourceOccurrenceCount: sourceRows.length,
            sourceRowNumbers: sourceRows,
            sourceRowNumber: sourceRows[0] ?? null,
          }),
          `Two or more distinct canonical source values currently claim one existing transaction. ` +
            "They were not collapsed, imported, or assigned automatically; correct the source identity before continuing.",
        ],
      );
      changedCount++;
    }
    for (const { staged, parsed } of changed) {
      const match = changedMatchBySourceRow.get(staged.sourceRowNumber) ?? { kind: "missing" as const };
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
      // A combined canonical + routing/net change is represented by exactly one
      // evidence conflict created above. It is deliberately non-applicable;
      // do not also create an ordinary apply-enabled conflict for the same row.
      if (sourceEvidenceConflictTxnIds.has(target.id)) continue;
      const audited = await isTransactionAudited(pool, target.id);
      const exactOccurrences = sourceOccurrenceEvidence(
        staging.rows
          .filter((candidate) => candidate.fingerprint === staged.fingerprint)
          .map((candidate) => candidate.sourceRowNumber),
      );
      const parsedIdentity: Record<string, unknown> = { ...sheetSourceIdentity(parsed) };
      const incomingIdentity = {
        ...parsedIdentity,
        ...exactOccurrences,
        sourceRowNumber: staged.sourceRowNumber,
        sourceFingerprint: staged.fingerprint,
        sourceEvidenceKeyVersion: SOURCE_EVIDENCE_KEY_VERSION,
        sourceEvidenceKeys: normalizedSourceEvidenceKeys([
          sourceEvidenceKey(parsedIdentity) ?? "",
        ]),
      };

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
          JSON.stringify(incomingIdentity),
          audited
            ? "The sheet changed a transaction that has an audited manual correction. It was NOT overwritten."
            : "The sheet changed an existing transaction's hours, rate or amount. Review and apply.",
        ],
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
      source_row_number: number | null;
      identity: unknown;
    }>(
      `SELECT id, payroll_transaction_id, natural_key, fingerprint, source_row_number, identity
         FROM sheet_sync_rows
        WHERE state IN ('active','conflict') AND payroll_transaction_id IS NOT NULL`,
    );
    for (const row of tracked) {
      reviewTxnIds.add(row.payroll_transaction_id);
      // Whole-row absence can be explicitly accepted while another review
      // facet remains open. Keep that durable marker in identity so conflict
      // recomputation order cannot cause the missing review to reappear.
      if (jsonRecord(row.identity).sourceMissingAccepted === true) continue;
      const presence = classifyTrackedSourcePresence(
        { fingerprint: row.fingerprint, naturalKey: row.natural_key },
        { fingerprints: snapshotFingerprints, changedNaturalKeys },
      );
      if (presence !== "missing") continue;
      const { rows: openMissing } = await pool.query<{ id: string; previous: unknown }>(
        `SELECT id, previous FROM sheet_sync_conflicts
          WHERE payroll_transaction_id = $1 AND type = 'missing' AND status = 'open'
          ORDER BY created_at DESC LIMIT 1`,
        [row.payroll_transaction_id],
      );
      const existingConflict = openMissing[0];
      const trackedEvidence = sourceOccurrenceEvidenceFromIdentity(row.identity, row.source_row_number);
      const existingPrevious = existingConflict ? jsonRecord(existingConflict.previous) : {};
      const existingExpectedCount = positiveInteger(existingPrevious.sourceOccurrenceCount);
      const expectedCount = Math.max(trackedEvidence.sourceOccurrenceCount, existingExpectedCount ?? 0);
      const baselineIdentity = existingExpectedCount !== null
        && existingExpectedCount >= trackedEvidence.sourceOccurrenceCount
        ? existingPrevious
        : jsonRecord(row.identity);
      const previousPayload = {
        ...baselineIdentity,
        sourceOccurrenceCount: expectedCount,
        sourceRowNumbers: sourceOccurrenceEvidenceFromIdentity(
          baselineIdentity,
          row.source_row_number,
        ).sourceRowNumbers,
      };
      const incomingPayload: SourceOccurrenceEvidence = {
        sourceOccurrenceCount: 0,
        sourceRowNumbers: [],
      };
      const detail = expectedCount > 1
        ? `All ${expectedCount} exact source occurrences for this canonical transaction are now absent. ` +
          "The one canonical transaction was NOT deleted; review the occurrence evidence."
        : "This transaction's source row is no longer in the sheet. It was NOT deleted; review it.";

      if (!existingConflict) {
        await pool.query(
          `INSERT INTO sheet_sync_conflicts
             (run_id, sync_row_id, payroll_transaction_id, type, natural_key,
              previous, incoming, detail, status)
           VALUES ($1,$2,$3,'missing',$4,$5::jsonb,$6::jsonb,$7,'open')`,
          [
            runId,
            row.id,
            row.payroll_transaction_id,
            row.natural_key,
            JSON.stringify(previousPayload),
            JSON.stringify(incomingPayload),
            detail,
          ],
        );
        missingCount++;
      } else {
        await pool.query(
          `UPDATE sheet_sync_conflicts
              SET run_id = $2, sync_row_id = COALESCE(sync_row_id, $3),
                  previous = $4::jsonb, incoming = $5::jsonb, detail = $6, updated_at = now()
            WHERE id = $1`,
          [
            existingConflict.id,
            runId,
            row.id,
            JSON.stringify(previousPayload),
            JSON.stringify(incomingPayload),
            detail,
          ],
        );
      }
    }

    // Derive the soft transaction flag and tracking state from the complete
    // open-conflict set once, with missing evidence taking precedence over a
    // simultaneous changed-evidence issue. Dismissing or restoring one facet
    // can therefore never mask another.
    if (reviewTxnIds.size > 0) {
      const ids = [...reviewTxnIds];
      await pool.query(
        `UPDATE payroll_transactions AS txn
            SET sync_review_reason = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM sheet_sync_conflicts conflict
                     WHERE conflict.payroll_transaction_id = txn.id
                       AND conflict.status = 'open' AND conflict.type = 'missing'
                  ) THEN 'source_missing'
                  WHEN EXISTS (
                    SELECT 1 FROM sheet_sync_conflicts conflict
                     WHERE conflict.payroll_transaction_id = txn.id
                       AND conflict.status = 'open' AND conflict.type = 'changed'
                  ) THEN 'source_changed'
                  ELSE NULL
                END,
                updated_at = now()
          WHERE txn.id = ANY($1::uuid[])`,
        [ids],
      );
      await pool.query(
        `UPDATE sheet_sync_rows AS tracking
            SET state = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM sheet_sync_conflicts conflict
                     WHERE conflict.payroll_transaction_id = tracking.payroll_transaction_id
                       AND conflict.status = 'open' AND conflict.type = 'missing'
                  ) THEN 'missing'
                  WHEN EXISTS (
                    SELECT 1 FROM sheet_sync_conflicts conflict
                     WHERE conflict.payroll_transaction_id = tracking.payroll_transaction_id
                       AND conflict.status = 'open' AND conflict.type = 'changed'
                  ) THEN 'conflict'
                  ELSE 'active'
                END,
                updated_at = now()
          WHERE tracking.payroll_transaction_id = ANY($1::uuid[])`,
        [ids],
      );
    }

    const flagged = changedCount + missingCount + atomicGroupHolds.length;
    let scheduleMatching = noScheduleMatchingNeeded();
    const starts: string[] = [];
    const ends: string[] = [];
    // A changed snapshot must not discard the last run's unfinished matching
    // work. Carry its dates into this attempt even when the source change adds
    // no transactions (for example, a Paid evidence edit or a held conflict).
    const pendingMatch = priorSync?.scheduleMatching;
    if (pendingMatch?.status === "needs_review" && pendingMatch.from && pendingMatch.to) {
      starts.push(pendingMatch.from);
      ends.push(pendingMatch.to);
    }
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
      note: [
        staging.reconciliation.note,
        controlScopeNote,
        scheduleMatchingNote(scheduleMatching),
      ].filter((note): note is string => note !== null).join(" "),
      scheduleMatching,
      sheetControlAudit,
      sourceTrackingVersion: SHEET_SYNC_SOURCE_TRACKING_VERSION,
      pendingAtomicGroupHolds: atomicGroupHolds,
      ...(recoveredTrackingRows > 0 ? { recoveredTrackingRows } : {}),
    };
    const skippedCount = unchangedCount + sourceDuplicateCount;
    base.reconciliation = syncReconciliation;
    await finishRun(pool, runId, {
      status: "success",
      sourceRows: parsedRows.length,
      added,
      updated: 0,
      skipped: skippedCount,
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
        skipped: skippedCount,
        repeatedSourceOccurrences: sourceDuplicateCount,
        changed: changedCount,
        missing: missingCount,
        atomicGroupHolds: atomicGroupHolds.length,
        failed: invalidCount,
        recoveredTrackingRows,
        scheduleMatched: scheduleMatching.matched,
        scheduleConsidered: scheduleMatching.considered,
        scheduleMatchingStatus: scheduleMatching.status,
      },
    });

    const note =
      `${added} added, ${unchangedCount} unchanged` +
      (sourceDuplicateCount
        ? `, ${sourceDuplicateCount} repeated source occurrence${sourceDuplicateCount === 1 ? "" : "s"} preserved without duplicate transactions`
        : "") +
      (changedCount ? `, ${changedCount} changed flagged for review` : "") +
      (missingCount ? `, ${missingCount} missing flagged for review` : "") +
      (atomicGroupHolds.length
        ? `, ${atomicGroupHolds.length} multi-person group${atomicGroupHolds.length === 1 ? " was" : "s were"} held atomically for review`
        : "") +
      (invalidCount ? `, ${invalidCount} could not be parsed` : "") +
      (recoveredTrackingRows
        ? `, ${recoveredTrackingRows} prior interrupted import${recoveredTrackingRows === 1 ? " was" : "s were"} reattached to source tracking`
        : "") +
      ". " +
      syncReconciliation.note;

    return {
      ...base,
      status: "success",
      sourceRows: parsedRows.length,
      added,
      skipped: skippedCount,
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
    await finishRun(pool, runId, {
      status: "failed",
      error: message,
      importBatchId: base.importBatchId,
      reconciliation: sheetControlAudit
        ? {
            note: "Sheet controls were read before this sync failed.",
            sheetControlAudit,
          }
        : undefined,
    }).catch(() => undefined);
    await recordChange(pool, {
      actorId: opts.userId,
      action: "sheet_sync_failed",
      entityType: "sheet_sync_run",
      entityId: runId,
      extra: { message },
    }).catch(() => undefined);
    return { ...base, status: "failed", error: message, note: `Sync failed: ${message}` };
  } finally {
    if (syncLockClient) {
      let destroyConnection = false;
      try {
        // No business writes use this transaction. ROLLBACK simply releases
        // its transaction-scoped lock on every return/error path.
        await syncLockClient.query("ROLLBACK");
      } catch {
        // Never return a client that might still have an open transaction.
        destroyConnection = true;
      }
      syncLockClient.release(destroyConnection);
    }
  }
}
