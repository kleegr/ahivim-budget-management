import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { dec, toMoney, toHours } from "@/lib/money";
import { transactionFingerprint, type TransactionIdentity } from "@/lib/business/fingerprint";
import { calculateInternalAmount, compareInternalAmounts } from "@/lib/business/internal-rate";
import { evaluateRateException, type RateExceptionResult } from "@/lib/business/rate-exceptions";
import { stageAgainstDatabase } from "@/lib/import/pipeline";
import { stagingGroupHasMultipleIndividuals } from "@/lib/import/stage";
import { attributePayment } from "@/lib/manage/payment-attribution";
import { recordChange } from "@/lib/manage/audit";
import { ok, fail, type Result } from "@/lib/manage/errors";
import { parseSheetCsv } from "./parse-csv";
import { fetchSheetCsv, type CsvFetcher } from "./fetch";
import { getSyncConfig, type SheetSyncConfig } from "./config";
import {
  sheetSourceIdentity,
  sourceEvidenceKey,
  SOURCE_EVIDENCE_CONFLICT_MARKER,
  SOURCE_EVIDENCE_KEY_VERSION,
} from "./identity";
import {
  normalizedSourceEvidenceKeys,
  sourceOccurrenceEvidenceFromIdentity,
  storedSourceEvidence,
} from "./sync";

/**
 * SYNC CONFLICT RESOLUTION
 * ========================
 *
 * A "changed" or "missing" conflict is resolved by an explicit human action —
 * the daily sync never rewrites or deletes a production transaction on its own.
 *
 *   apply    (changed) : pull the sheet's CURRENT value for this identity into
 *                        the existing transaction, in place, fully audited.
 *                        REFUSED when the transaction carries an audited manual
 *                        correction, so a curated figure is never clobbered.
 *   dismiss           : keep the transaction as-is and close the conflict.
 *
 * Applying updates the same transaction row (no second, competing record is
 * created), so every downstream total stays correct with no change to any
 * existing aggregate query. The previous figures are captured in the audit log.
 */

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const SHEET_SYNC_ADVISORY_LOCK = "ahivim:sheet-sync:canonical-ledger:v1";

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

interface ConflictRow {
  id: string;
  run_id: string | null;
  sync_row_id: string | null;
  type: string;
  status: string;
  audited: boolean;
  natural_key: string;
  payroll_transaction_id: string | null;
  previous: unknown;
  incoming: unknown;
}

export function isSourceEvidenceConflict(previous: unknown): boolean {
  return jsonRecord(previous).sourceEvidenceConflict === SOURCE_EVIDENCE_CONFLICT_MARKER;
}

async function loadConflict(db: Queryable, id: string): Promise<ConflictRow | null> {
  const { rows } = await db.query<ConflictRow>(
    `SELECT id, run_id, sync_row_id, type, status, audited, natural_key,
            payroll_transaction_id, previous, incoming
       FROM sheet_sync_conflicts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

function clientAsPool(client: PgLikeClient): PgLikePool {
  return {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => client.query<T>(sql, params),
    connect: async () => {
      throw new Error("A nested database connection is not available inside a sync-resolution transaction.");
    },
  };
}

async function inResolutionTransaction<T>(
  pool: PgLikePool,
  operation: (client: PgLikeClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query("BEGIN");
    // Serialize with the inbound Sheet sync as well as other resolution actions.
    // This is transaction-scoped, so it is safe with Neon transaction pooling.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [SHEET_SYNC_ADVISORY_LOCK]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      rollbackFailed = true;
    }
    throw error;
  } finally {
    client.release(rollbackFailed || undefined);
  }
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

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function conflictSourceFingerprint(value: unknown): string | null {
  const incoming = jsonRecord(value);
  if (typeof incoming.sourceFingerprint === "string" && incoming.sourceFingerprint.trim()) {
    return incoming.sourceFingerprint.trim();
  }
  try {
    const identity: TransactionIdentity = {
      checkNumber: typeof incoming.checkNumber === "string" ? incoming.checkNumber : null,
      checkDate: typeof incoming.checkDate === "string" ? incoming.checkDate : null,
      employeeKey: typeof incoming.employee === "string" ? incoming.employee : null,
      individualKey: typeof incoming.individual === "string" ? incoming.individual : null,
      programKey: typeof incoming.program === "string" ? incoming.program : null,
      periodBegin: typeof incoming.periodBegin === "string" ? incoming.periodBegin : null,
      periodEnd: typeof incoming.periodEnd === "string" ? incoming.periodEnd : null,
      hours: String(incoming.hours ?? "0"),
      rate: String(incoming.rate ?? "0"),
      amount: String(incoming.amount ?? "0"),
    };
    return transactionFingerprint(identity);
  } catch {
    return null;
  }
}

function normalizedPayTo(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || null;
}

function normalizedNet(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  try {
    return toMoney(String(value));
  } catch {
    return `invalid:${String(value).trim().toLowerCase()}`;
  }
}

function sourceEvidenceChanged(previous: unknown, current: Record<string, unknown>): boolean {
  const previousEvidence = storedSourceEvidence(previous);
  if (previousEvidence.explicit) {
    const currentEvidence = storedSourceEvidence(current);
    return !currentEvidence.explicit
      || previousEvidence.keys.length !== currentEvidence.keys.length
      || previousEvidence.keys.some((key, index) => key !== currentEvidence.keys[index]);
  }
  const prior = jsonRecord(previous);
  return normalizedPayTo(prior.payTo) !== normalizedPayTo(current.payTo)
    || normalizedNet(prior.totalNetPay) !== normalizedNet(current.totalNetPay);
}

function trackingIdentity(
  current: Record<string, unknown>,
  _previousIdentity: unknown,
  fallbackSourceRowNumber: number | null,
): Record<string, unknown> {
  const occurrence = sourceOccurrenceEvidenceFromIdentity(current, fallbackSourceRowNumber);
  const evidenceKey = sourceEvidenceKey(current);
  if (!evidenceKey) {
    throw new Error("The current Sheet row does not have a valid source-evidence identity.");
  }
  return {
    ...current,
    ...occurrence,
    sourceEvidenceKeyVersion: SOURCE_EVIDENCE_KEY_VERSION,
    sourceEvidenceKeys: normalizedSourceEvidenceKeys([evidenceKey]),
  };
}

interface TrackingRow {
  id: string;
  source_row_number: number | null;
  identity: unknown;
}

interface CanonicalTransactionRow {
  imported_hours: string | null;
  imported_rate: string | null;
  imported_amount: string | null;
  pay_to_raw: string | null;
  total_net_pay: string | null;
  import_row_id: string | null;
}

interface ResolutionAuditSnapshot {
  transaction: unknown;
  serviceSession: unknown;
  serviceAllocations: unknown[];
  rateExceptions: unknown[];
  sourceTracking: unknown[];
  conflict: unknown;
}

async function captureResolutionAuditSnapshot(
  db: Queryable,
  input: {
    transactionId: string;
    serviceSessionId: string | null;
    conflictId: string;
  },
): Promise<ResolutionAuditSnapshot> {
  const { rows: transactionRows } = await db.query<{ snapshot: unknown }>(
    `SELECT to_jsonb(t) AS snapshot
       FROM payroll_transactions t WHERE t.id = $1 FOR UPDATE`,
    [input.transactionId],
  );
  const sessionRows = input.serviceSessionId
    ? (await db.query<{ snapshot: unknown }>(
        `SELECT to_jsonb(s) AS snapshot
           FROM service_sessions s WHERE s.id = $1 FOR UPDATE`,
        [input.serviceSessionId],
      )).rows
    : [];
  const allocationRows = input.serviceSessionId
    ? (await db.query<{ snapshot: unknown }>(
        `SELECT to_jsonb(a) AS snapshot
           FROM service_allocations a
          WHERE a.service_session_id = $1
          ORDER BY a.id FOR UPDATE`,
        [input.serviceSessionId],
      )).rows
    : [];
  const { rows: rateExceptionRows } = await db.query<{ snapshot: unknown }>(
    `SELECT to_jsonb(r) AS snapshot
       FROM rate_exceptions r
      WHERE r.payroll_transaction_id = $1
      ORDER BY r.id FOR UPDATE`,
    [input.transactionId],
  );
  const { rows: trackingRows } = await db.query<{ snapshot: unknown }>(
    `SELECT to_jsonb(s) AS snapshot
       FROM sheet_sync_rows s
      WHERE s.payroll_transaction_id = $1
      ORDER BY s.id FOR UPDATE`,
    [input.transactionId],
  );
  const { rows: conflictRows } = await db.query<{ snapshot: unknown }>(
    `SELECT to_jsonb(c) AS snapshot
       FROM sheet_sync_conflicts c WHERE c.id = $1 FOR UPDATE`,
    [input.conflictId],
  );
  return {
    transaction: transactionRows[0]?.snapshot ?? null,
    serviceSession: sessionRows[0]?.snapshot ?? null,
    serviceAllocations: allocationRows.map((row) => row.snapshot),
    rateExceptions: rateExceptionRows.map((row) => row.snapshot),
    sourceTracking: trackingRows.map((row) => row.snapshot),
    conflict: conflictRows[0]?.snapshot ?? null,
  };
}

interface OpenRateExceptionRow {
  id: string;
  imported_rate: string;
  expected_rate: string;
}

async function reconcileAppliedRateException(
  db: Queryable,
  input: {
    transactionId: string;
    importBatchId: string | null;
    individualId: string | null;
    programId: string | null;
    current: RateExceptionResult | null;
  },
): Promise<{ retainedId: string | null; insertedId: string | null; correctedIds: string[] }> {
  const { rows } = await db.query<OpenRateExceptionRow>(
    `SELECT id, imported_rate::text, expected_rate::text
       FROM rate_exceptions
      WHERE payroll_transaction_id = $1 AND resolution = 'open'
      ORDER BY created_at, id
      FOR UPDATE`,
    [input.transactionId],
  );

  let retainedId: string | null = null;
  if (input.current) {
    retainedId = rows.find((row) =>
      toMoney(row.imported_rate) === input.current!.importedRate
      && toMoney(row.expected_rate) === input.current!.expectedRate,
    )?.id ?? null;
  }
  const correctedIds = rows
    .filter((row) => row.id !== retainedId)
    .map((row) => row.id);
  if (correctedIds.length > 0) {
    await db.query(
      `UPDATE rate_exceptions
          SET resolution = 'corrected',
              note = concat_ws(E'\n', NULLIF(note, ''), $2),
              updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [correctedIds, "Superseded when the reviewed Sheet change was applied to the canonical transaction."],
    );
  }

  let insertedId: string | null = null;
  if (input.current && !retainedId) {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO rate_exceptions
         (import_batch_id, payroll_transaction_id, individual_id, program_id,
          imported_rate, expected_rate, variance_amount, variance_percent, direction, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        input.importBatchId,
        input.transactionId,
        input.individualId,
        input.programId,
        input.current.importedRate,
        input.current.expectedRate,
        input.current.varianceAmount,
        input.current.variancePercent,
        input.current.direction === "match" ? "higher" : input.current.direction,
        input.current.summary,
      ],
    );
    insertedId = inserted.rows[0]?.id ?? null;
  }

  return { retainedId, insertedId, correctedIds };
}

function canonicalValue(value: unknown, kind: "hours" | "money"): string {
  try {
    return kind === "hours" ? toHours(String(value ?? "0")) : toMoney(String(value ?? "0"));
  } catch {
    return `invalid:${String(value ?? "").trim().toLowerCase()}`;
  }
}

function hasCanonicalChange(transaction: CanonicalTransactionRow, incoming: Record<string, unknown>): boolean {
  return canonicalValue(transaction.imported_hours, "hours") !== canonicalValue(incoming.hours, "hours")
    || canonicalValue(transaction.imported_rate, "money") !== canonicalValue(incoming.rate, "money")
    || canonicalValue(transaction.imported_amount, "money") !== canonicalValue(incoming.amount, "money");
}

function withoutEvidenceConflictMarker(value: unknown): Record<string, unknown> {
  const copy = { ...jsonRecord(value) };
  delete copy.sourceEvidenceConflict;
  delete copy.sourceEvidenceConflictReason;
  return copy;
}

function adoptedTrackingEvidence(
  existingIdentity: unknown,
  incoming: unknown,
  fallbackSourceRowNumber: number | null,
): { identity: Record<string, unknown>; sourceRowNumber: number | null } {
  const existing = { ...jsonRecord(existingIdentity) };
  const accepted = jsonRecord(incoming);
  const occurrence = sourceOccurrenceEvidenceFromIdentity(accepted, fallbackSourceRowNumber);

  // Copy only the evidence facet. Canonical hours/rate/amount in the tracking
  // identity remain aligned with the unchanged Neon transaction until a
  // separate ordinary changed conflict is explicitly applied.
  existing.payTo = Object.hasOwn(accepted, "payTo") ? accepted.payTo : null;
  existing.totalNetPay = Object.hasOwn(accepted, "totalNetPay") ? accepted.totalNetPay : null;
  existing.sourceEvidenceKeyVersion = typeof accepted.sourceEvidenceKeyVersion === "string"
    ? accepted.sourceEvidenceKeyVersion
    : SOURCE_EVIDENCE_KEY_VERSION;
  existing.sourceEvidenceKeys = normalizedSourceEvidenceKeys(
    Array.isArray(accepted.sourceEvidenceKeys) ? accepted.sourceEvidenceKeys : [],
  );
  if (Array.isArray(accepted.sourceEvidenceVariants)) {
    existing.sourceEvidenceVariants = accepted.sourceEvidenceVariants;
  } else {
    delete existing.sourceEvidenceVariants;
  }
  existing.sourceOccurrenceCount = occurrence.sourceOccurrenceCount;
  existing.sourceRowNumbers = occurrence.sourceRowNumbers;

  return {
    identity: existing,
    sourceRowNumber: occurrence.sourceRowNumbers[0] ?? fallbackSourceRowNumber,
  };
}

async function transactionHasAuditedCorrection(
  db: Queryable,
  importRowId: string | null,
): Promise<boolean> {
  if (!importRowId) return false;
  const { rows } = await db.query<{ correction_status: string | null; corrected_values: unknown }>(
    `SELECT correction_status, corrected_values FROM import_rows WHERE id = $1 FOR UPDATE`,
    [importRowId],
  );
  const row = rows[0];
  return Boolean(row && (row.correction_status === "corrected" || row.corrected_values !== null));
}

async function retainCanonicalConflict(
  db: Queryable,
  conflict: ConflictRow,
  transaction: CanonicalTransactionRow,
  audited: boolean,
): Promise<void> {
  const incoming = withoutEvidenceConflictMarker(conflict.incoming);
  const previous = withoutEvidenceConflictMarker(conflict.previous);
  previous.hours = transaction.imported_hours ?? "0";
  previous.rate = transaction.imported_rate ?? "0";
  previous.amount = transaction.imported_amount ?? "0";
  // The operator just accepted this evidence facet. Carry it into the ordinary
  // conflict baseline so applying canonical figures does not re-litigate it.
  previous.payTo = Object.hasOwn(incoming, "payTo") ? incoming.payTo : previous.payTo ?? transaction.pay_to_raw;
  previous.totalNetPay = Object.hasOwn(incoming, "totalNetPay")
    ? incoming.totalNetPay
    : previous.totalNetPay ?? transaction.total_net_pay;
  for (const key of [
    "sourceEvidenceKeyVersion",
    "sourceEvidenceKeys",
    "sourceEvidenceVariants",
    "sourceOccurrenceCount",
    "sourceRowNumbers",
  ]) {
    if (Object.hasOwn(incoming, key)) previous[key] = incoming[key];
    else delete previous[key];
  }

  const { rows: ordinaryRows } = await db.query<{ id: string }>(
    `SELECT id
       FROM sheet_sync_conflicts
      WHERE payroll_transaction_id = $1
        AND type = 'changed' AND status = 'open'
        AND COALESCE(previous->>'sourceEvidenceConflict', '') <> $2
      ORDER BY created_at DESC, id DESC
      FOR UPDATE`,
    [conflict.payroll_transaction_id, SOURCE_EVIDENCE_CONFLICT_MARKER],
  );
  const keeper = ordinaryRows[0];
  const duplicateIds = ordinaryRows.slice(1).map((row) => row.id);
  if (duplicateIds.length > 0) {
    await db.query(
      `UPDATE sheet_sync_conflicts
          SET status = 'superseded', resolution = 'duplicate_canonical_review',
              resolved_at = now(), updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'open'`,
      [duplicateIds],
    );
  }

  const detail = audited
    ? "The Sheet changed canonical hours, rate, or amount on a transaction with an audited correction. It was not overwritten."
    : "Pay-To or Total Net Pay evidence was accepted, but the Sheet also changed canonical hours, rate, or amount. Review and apply that change separately.";
  if (keeper) {
    await db.query(
      `UPDATE sheet_sync_conflicts
          SET run_id = $2, sync_row_id = COALESCE($3, sync_row_id), audited = $4,
              natural_key = $5, previous = $6::jsonb, incoming = $7::jsonb,
              detail = $8, updated_at = now()
        WHERE id = $1 AND status = 'open'`,
      [
        keeper.id,
        conflict.run_id,
        conflict.sync_row_id,
        audited,
        conflict.natural_key,
        JSON.stringify(previous),
        JSON.stringify(incoming),
        detail,
      ],
    );
    return;
  }

  await db.query(
    `INSERT INTO sheet_sync_conflicts
       (run_id, sync_row_id, payroll_transaction_id, type, audited, natural_key,
        previous, incoming, detail, status)
     VALUES ($1,$2,$3,'changed',$4,$5,$6::jsonb,$7::jsonb,$8,'open')`,
    [
      conflict.run_id,
      conflict.sync_row_id,
      conflict.payroll_transaction_id,
      audited,
      conflict.natural_key,
      JSON.stringify(previous),
      JSON.stringify(incoming),
      detail,
    ],
  );
}

/** Derive transaction and tracking flags from all review items that remain open. */
async function recomputeOpenConflictState(
  db: Queryable,
  transactionId: string,
  clearTrackingState = "active",
): Promise<void> {
  const { rows } = await db.query<{ has_missing: boolean; has_changed: boolean }>(
    `SELECT COALESCE(bool_or(type = 'missing'), false) AS has_missing,
            COALESCE(bool_or(type = 'changed'), false) AS has_changed
       FROM sheet_sync_conflicts
      WHERE payroll_transaction_id = $1
        AND status = 'open'
        AND type IN ('missing', 'changed')`,
    [transactionId],
  );
  const state = rows[0] ?? { has_missing: false, has_changed: false };
  const reason = state.has_missing ? "source_missing" : state.has_changed ? "source_changed" : null;
  const trackingState = state.has_missing ? "missing" : state.has_changed ? "conflict" : clearTrackingState;
  await db.query(
    `UPDATE payroll_transactions SET sync_review_reason = $2, updated_at = now() WHERE id = $1`,
    [transactionId, reason],
  );
  await db.query(
    `UPDATE sheet_sync_rows SET state = $2, updated_at = now() WHERE payroll_transaction_id = $1`,
    [transactionId, trackingState],
  );
}

export interface ResolveOptions {
  fetcher?: CsvFetcher;
  config?: SheetSyncConfig;
}

/** Apply the sheet's current value for a changed row into its existing transaction. */
export async function applyChangedConflict(
  pool: PgLikePool,
  conflictId: string,
  actorId: string | null,
  opts: ResolveOptions = {},
): Promise<Result<{ transactionId: string }>> {
  if (!isUuid(conflictId)) return fail("not_found", "That conflict no longer exists.");
  return inResolutionTransaction(pool, async (client) => {
    const conflict = await loadConflict(client, conflictId);
    if (!conflict) return fail("not_found", "That conflict no longer exists.");
    if (conflict.status !== "open") return fail("conflict", "That conflict has already been resolved.");
    if (conflict.type !== "changed") return fail("validation", "Only a changed row can be applied.");
    if (isSourceEvidenceConflict(conflict.previous)) {
      return fail(
        "immutable",
        "Pay To or Total Net Pay source evidence cannot be applied as a transaction value. " +
          "Correct or restore the source evidence, or dismiss this review item explicitly.",
      );
    }
    if (!conflict.payroll_transaction_id) {
      return fail("not_found", "The transaction for this conflict is missing.");
    }
    const txnId = conflict.payroll_transaction_id;
    const db = clientAsPool(client);

    // Lock the transaction and its import evidence before checking curation or
    // staging the current Sheet. No correction can race between the check and apply.
    const { rows: beforeRows } = await client.query<{
      imported_hours: string | null; imported_rate: string | null; imported_amount: string | null;
      calculated_internal_amount: string | null; transaction_fingerprint: string; pay_to_raw: string | null;
      total_net_pay: string | null; employee_raw: string | null; employee_id: string | null;
      individual_id: string | null; program_id: string | null; import_batch_id: string | null;
      import_row_id: string | null; internal_rate_applied: string | null; agency_rate_applied: string | null;
      service_session_id: string | null; is_group_service: boolean;
    }>(
      `SELECT imported_hours::text, imported_rate::text, imported_amount::text,
              calculated_internal_amount::text, transaction_fingerprint, pay_to_raw,
              total_net_pay::text, employee_raw, employee_id, individual_id, program_id, import_batch_id, import_row_id,
              internal_rate_applied::text, agency_rate_applied::text, service_session_id, is_group_service
         FROM payroll_transactions WHERE id = $1 FOR UPDATE`,
      [txnId],
    );
    const before = beforeRows[0];
    if (!before) return fail("not_found", "That transaction no longer exists.");
    let linkedSession: {
      group_size: number;
      validation_result: unknown;
    } | null = null;
    let linkedAllocations: {
      id: string;
      individual_id: string;
      payroll_transaction_id: string | null;
    }[] = [];
    let linkedTransactions: { id: string }[] = [];
    if (before.service_session_id) {
      const sessionResult = await client.query<{
        group_size: number;
        validation_result: unknown;
      }>(
        `SELECT group_size, validation_result
           FROM service_sessions WHERE id = $1 FOR UPDATE`,
        [before.service_session_id],
      );
      linkedSession = sessionResult.rows[0] ?? null;
      const allocationResult = await client.query<{
        id: string;
        individual_id: string;
        payroll_transaction_id: string | null;
      }>(
        `SELECT id, individual_id, payroll_transaction_id
           FROM service_allocations WHERE service_session_id = $1 FOR UPDATE`,
        [before.service_session_id],
      );
      linkedAllocations = allocationResult.rows;
      const transactionResult = await client.query<{ id: string }>(
        `SELECT id
           FROM payroll_transactions WHERE service_session_id = $1 FOR UPDATE`,
        [before.service_session_id],
      );
      linkedTransactions = transactionResult.rows;

      const linkedDistinctIndividuals = linkedSession
        ? jsonRecord(linkedSession.validation_result).distinctIndividuals
        : null;
      const hasOtherAllocation = linkedAllocations.some((allocation) =>
        allocation.individual_id !== before.individual_id
        || (allocation.payroll_transaction_id !== null && allocation.payroll_transaction_id !== txnId),
      );
      if (
        before.is_group_service
        || linkedTransactions.some((transaction) => transaction.id !== txnId)
        || hasOtherAllocation
        || (linkedSession && linkedSession.group_size > 1 && linkedDistinctIndividuals !== false)
      ) {
        return fail(
          "immutable",
          "This transaction belongs to a multi-person or unresolved group-service session. A single row cannot be applied without changing the whole session and its allocations; correct the Sheet group and sync again.",
        );
      }
    }
    if (before.import_row_id) {
      const { rows: importRows } = await client.query<{
        correction_status: string | null; corrected_values: unknown;
      }>(
        `SELECT correction_status, corrected_values
           FROM import_rows WHERE id = $1 FOR UPDATE`,
        [before.import_row_id],
      );
      const importRow = importRows[0];
      if (importRow && (importRow.correction_status === "corrected" || importRow.corrected_values !== null)) {
        return fail(
          "immutable",
          "This transaction has an audited manual correction. It cannot be overwritten by the sheet. " +
            "Resolve the correction first, or dismiss this conflict.",
        );
      }
    }

    // Pull and stage the current source while holding the same advisory lock as
    // sync. The Sheet itself remains read-only; all writes below are Neon-only.
    const config = opts.config ?? (await getSyncConfig(db));
    const fetcher: CsvFetcher = opts.fetcher ?? fetchSheetCsv;
    const csv = await fetcher(config);
    const parse = parseSheetCsv(csv);
    const staging = await stageAgainstDatabase(db, parse.ahivimRows, {
      agencyGross: parse.wholeSheetControlTotals.agencyGross,
      internalAmount: parse.wholeSheetControlTotals.internalAmount,
    }, { canonicalizeSourceDuplicates: true });

    const matches = staging.rows.filter((r) => r.naturalKey === conflict.natural_key && r.status !== "invalid");
    if (matches.length === 0) {
      // The change reverted or the row was removed; close and recompute as one transaction.
      const auditBefore = await captureResolutionAuditSnapshot(client, {
        transactionId: txnId,
        serviceSessionId: before.service_session_id,
        conflictId,
      });
      await closeConflict(client, conflictId, "dismissed", "source_reverted", actorId,
        "The changed value is no longer in the sheet; nothing was applied.");
      await recomputeOpenConflictState(client, txnId);
      const auditAfter = await captureResolutionAuditSnapshot(client, {
        transactionId: txnId,
        serviceSessionId: before.service_session_id,
        conflictId,
      });
      await recordChange(client, {
        actorId,
        action: "sheet_sync_change_source_reverted",
        entityType: "sheet_sync_conflict",
        entityId: conflictId,
        previous: auditBefore,
        next: auditAfter,
        reason: "The reviewed source identity is no longer present; the change conflict was closed without applying transaction values.",
        extra: { transactionId: txnId },
      });
      return fail("conflict", "The changed value is no longer in the sheet, so there is nothing to apply. The conflict was closed.");
    }
    const matchedSourceRows = new Set(matches.map((row) => row.sourceRowNumber));
    const currentSourceGroup = staging.groups.find((group) =>
      group.sourceRowRefs.some((sourceRowNumber) => matchedSourceRows.has(sourceRowNumber)),
    );
    const currentGroup = staging.groups.find((group) =>
      group.groupSize > 1
      && stagingGroupHasMultipleIndividuals(group, staging.rows)
      && group.sourceRowRefs.some((sourceRowNumber) => matchedSourceRows.has(sourceRowNumber)),
    );
    if (currentGroup) {
      return fail(
        "immutable",
        "The current Sheet row is part of a multi-person service group. A single row cannot be applied without creating or changing the whole session and its allocations; correct the Sheet group and sync again.",
      );
    }
    const { rows: trackingRows } = await client.query<{
      id: string; source_row_number: number | null; identity: unknown;
    }>(
      `SELECT id, source_row_number, identity
         FROM sheet_sync_rows WHERE payroll_transaction_id = $1 FOR UPDATE`,
      [txnId],
    );
    const tracking = trackingRows[0];
    if (!tracking) {
      throw new Error("The sync tracking row for this conflict is missing; no transaction value was changed.");
    }

    const fingerprints = [...new Set(matches.map((match) => match.fingerprint).filter(Boolean))];
    const reviewedIncoming = jsonRecord(conflict.incoming);
    const reviewedCount = nonNegativeInteger(reviewedIncoming.sourceOccurrenceCount);
    const expectedOccurrence = reviewedCount && reviewedCount > 0
      ? reviewedCount
      : sourceOccurrenceEvidenceFromIdentity(tracking.identity, tracking.source_row_number).sourceOccurrenceCount;
    const reviewedFingerprint = conflictSourceFingerprint(reviewedIncoming);
    if (
      fingerprints.length !== 1
      || matches.length !== expectedOccurrence
      || (reviewedFingerprint !== null && fingerprints[0] !== reviewedFingerprint)
    ) {
      return fail(
        "conflict",
        "The Sheet rows for this identity no longer match the reviewed exact occurrence group; resolve the source ambiguity before applying.",
      );
    }

    const parsedMatches = matches.map((match) => ({
      staged: match,
      parsedRow: parse.ahivimRows.find((row) => row.sourceRowNumber === match.sourceRowNumber),
    }));
    if (parsedMatches.some(({ parsedRow }) => !parsedRow?.parsed)) {
      return fail("validation", "One of the Sheet rows could not be read for applying.");
    }
    const identities = parsedMatches.map(({ parsedRow }) => sheetSourceIdentity(parsedRow!));
    if (identities.some((identity) => "raw" in identity)) {
      return fail("validation", "One of the Sheet rows does not have a usable source identity.");
    }
    const identityRecords = identities.map((identity) => ({ ...identity } as Record<string, unknown>));
    const evidenceKeys = normalizedSourceEvidenceKeys(
      identityRecords.map((identity) => sourceEvidenceKey(identity) ?? ""),
    );
    if (evidenceKeys.length !== 1) {
      return fail(
        "conflict",
        "The Sheet rows disagree on Pay To or Total Net Pay evidence; resolve that source ambiguity before applying.",
      );
    }

    const staged = parsedMatches[0]!.staged;
    const parsedRow = parsedMatches[0]!.parsedRow!;
    const parsed = parsedRow.parsed!;
    const currentIdentity = identityRecords[0]!;
    const occurrence = {
      sourceOccurrenceCount: matches.length,
      sourceRowNumbers: matches.map((match) => match.sourceRowNumber).sort((a, b) => a - b),
    };
    const currentIdentityRecord: Record<string, unknown> = {
      ...currentIdentity,
      ...occurrence,
      sourceFingerprint: fingerprints[0]!,
      sourceEvidenceKeyVersion: SOURCE_EVIDENCE_KEY_VERSION,
      sourceEvidenceKeys: evidenceKeys,
      sourceEvidenceVariants: [{
        payTo: "payTo" in currentIdentity ? currentIdentity.payTo : null,
        totalNetPay: "totalNetPay" in currentIdentity ? currentIdentity.totalNetPay : null,
        sourceRowNumbers: occurrence.sourceRowNumbers,
      }],
    };
    if (sourceEvidenceChanged(tracking.identity, currentIdentityRecord)) {
      return fail(
        "immutable",
        "Pay To or Total Net Pay source evidence changed with this row. " +
          "Dismiss that evidence review explicitly before applying canonical hours, rate, or amount.",
      );
    }
    const nextTrackingIdentity = trackingIdentity(currentIdentityRecord, tracking.identity, tracking.source_row_number);
    const recalculatedInternal = calculateInternalAmount({
      payTo: before.pay_to_raw,
      importedAmount: parsed.amount,
      agencyRate: staged.agencyRateApplied ?? null,
      internalRate: staged.internalRateApplied ?? null,
      hours: parsed.hours,
      rowRate: parsed.rate,
    });
    const internalComparison = compareInternalAmounts(
      staged.spreadsheetInternalAmount,
      recalculatedInternal.internalAmount,
    );
    const internalAmountMismatch = !internalComparison.matches && Boolean(internalComparison.spreadsheetValue);
    const hasCurrentRateWarning = staging.warnings.some((warning) =>
      warning.category === "rate_exception"
      && warning.sourceRowNumber !== null
      && matchedSourceRows.has(warning.sourceRowNumber),
    );
    if (hasCurrentRateWarning && staged.internalRateApplied == null) {
      throw new Error("The staged rate exception has no configured expected rate; no transaction value was changed.");
    }
    const currentRateException = hasCurrentRateWarning
      ? evaluateRateException({
          importedRate: parsed.rate,
          expectedRate: staged.internalRateApplied!,
      })
      : null;

    const auditBefore = await captureResolutionAuditSnapshot(client, {
      transactionId: txnId,
      serviceSessionId: before.service_session_id,
      conflictId,
    });

    // Apply only the ordinary canonical figures. Pay-To and Total Net Pay remain
    // immutable source evidence and are intentionally absent from this UPDATE.
    // Recalculate every Pay-To-dependent value from the preserved Neon Pay-To;
    // the current Sheet evidence may have been acknowledged without being
    // adopted and therefore cannot drive routing or internal money indirectly.
    await client.query(
      `UPDATE payroll_transactions
          SET imported_hours = $2, imported_rate = $3, imported_amount = $4,
              spreadsheet_internal_amount = $5, calculated_internal_amount = $6,
              internal_amount_mismatch = $7, transaction_fingerprint = $8, duplicate_status = 'new',
              internal_rate_applied = $9, agency_rate_applied = $10,
              updated_at = now()
        WHERE id = $1`,
      [
        txnId,
        toHours(parsed.hours),
        toMoney(parsed.rate),
        toMoney(parsed.amount),
        internalComparison.spreadsheetValue,
        recalculatedInternal.internalAmount,
        internalAmountMismatch,
        staged.fingerprint,
        staged.internalRateApplied ?? null,
        staged.agencyRateApplied ?? null,
      ],
    );

    // Re-derive the attribution columns from the preserved Neon Pay-To value.
    const employeeName = before.employee_id
      ? (await client.query<{ n: string | null }>(`SELECT display_name AS n FROM employees WHERE id = $1`, [before.employee_id])).rows[0]?.n ?? before.employee_raw
      : before.employee_raw;
    const attribution = attributePayment({
      payToRaw: before.pay_to_raw,
      employeeName,
      importedAmount: toMoney(parsed.amount),
      internalAmount: recalculatedInternal.internalAmount ?? internalComparison.spreadsheetValue,
    });
    await client.query(
      `UPDATE payroll_transactions
          SET payment_recipient = $2, employee_payment_amount = $3, agency_additional_amount = $4, updated_at = now()
        WHERE id = $1`,
      [txnId, attribution.recipient, attribution.employeePayment, attribution.agencyAdditional],
    );

    // Ordinary imports also have a one-person service session and allocation.
    // Keep that canonical service evidence synchronized with the transaction;
    // only true multi-person/unresolved groups are refused above.
    if (before.service_session_id && linkedSession) {
      const canonicalSessionAmount = toMoney(dec(parsed.hours).times(parsed.rate));
      await client.query(
        `UPDATE service_sessions
            SET physical_hours = $2, group_size = 1,
                combined_rate = $3, combined_amount = $4, base_individual_rate = $3,
                group_detection_status = 'single', detection_rule = 'single_row_no_group',
                detection_signature = $5, confidence = 1,
                validation_result = $6::jsonb, warning_reason = NULL,
                source_row_refs = $7::jsonb, updated_at = now()
          WHERE id = $1`,
        [
          before.service_session_id,
          toHours(parsed.hours),
          toMoney(parsed.rate),
          canonicalSessionAmount,
          currentSourceGroup?.signature ?? null,
          JSON.stringify({
            distinctIndividuals: true,
            hoursMatch: true,
            employeeMatches: true,
            programMatches: true,
            combinedRateReconciles: true,
            amountDividesEqually: true,
          }),
          JSON.stringify(occurrence.sourceRowNumbers),
        ],
      );
      if (before.individual_id) {
        await client.query(
          `INSERT INTO service_allocations
             (service_session_id, individual_id, payroll_transaction_id,
              allocation_hours, allocated_rate, allocated_amount, rounding_adjustment)
           VALUES ($1,$2,$3,$4,$5,$6,0)
           ON CONFLICT (service_session_id, individual_id) DO UPDATE
             SET payroll_transaction_id = EXCLUDED.payroll_transaction_id,
                 allocation_hours = EXCLUDED.allocation_hours,
                 allocated_rate = EXCLUDED.allocated_rate,
                 allocated_amount = EXCLUDED.allocated_amount,
                 rounding_adjustment = 0,
                 updated_at = now()`,
          [
            before.service_session_id,
            before.individual_id,
            txnId,
            toHours(parsed.hours),
            toMoney(parsed.rate),
            canonicalSessionAmount,
          ],
        );
      }
    }

    // The review queue must describe the canonical rate that now exists. Close
    // stale open exceptions and create (or retain exactly one) current exception
    // in the same transaction as the ledger update. Accepted history is kept.
    const rateExceptionReconciliation = await reconcileAppliedRateException(client, {
      transactionId: txnId,
      importBatchId: before.import_batch_id,
      individualId: before.individual_id,
      programId: before.program_id,
      current: currentRateException,
    });

    await client.query(
      `UPDATE sheet_sync_rows
          SET fingerprint = $2, source_row_number = $3, identity = $4::jsonb,
              last_seen_at = now(), updated_at = now()
        WHERE id = $1`,
      [tracking.id, staged.fingerprint, occurrence.sourceRowNumbers[0] ?? staged.sourceRowNumber, JSON.stringify(nextTrackingIdentity)],
    );

    await closeConflict(client, conflictId, "applied", "applied", actorId,
      "The Sheet's current canonical hours, rate, and amount were applied to the transaction.");
    await recomputeOpenConflictState(client, txnId);

    const auditAfter = await captureResolutionAuditSnapshot(client, {
      transactionId: txnId,
      serviceSessionId: before.service_session_id,
      conflictId,
    });

    await recordChange(client, {
      actorId,
      action: "sheet_sync_change_applied",
      entityType: "payroll_transaction",
      entityId: txnId,
      previous: auditBefore,
      next: auditAfter,
      reason: `Applied from Google Sheet sync (conflict ${conflictId}).`,
      extra: {
        rateException: {
          retainedId: rateExceptionReconciliation.retainedId,
          insertedId: rateExceptionReconciliation.insertedId,
          correctedIds: rateExceptionReconciliation.correctedIds,
        },
      },
    });

    return ok({ transactionId: txnId });
  });
}

/** Keep the existing transaction and close a conflict (changed or missing). */
export async function dismissConflict(
  pool: PgLikePool,
  conflictId: string,
  actorId: string | null,
  note?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(conflictId)) return fail("not_found", "That conflict no longer exists.");
  return inResolutionTransaction(pool, async (client) => {
    const conflict = await loadConflict(client, conflictId);
    if (!conflict) return fail("not_found", "That conflict no longer exists.");
    if (conflict.status !== "open") return fail("conflict", "That conflict has already been resolved.");

    const sourceEvidence = isSourceEvidenceConflict(conflict.previous);
    let canonicalChangeRetained = false;
    let canonicalSourceAccepted = false;
    let acceptedWholeMissing = false;
    if (sourceEvidence) {
      if (!conflict.payroll_transaction_id) {
        return fail("not_found", "The transaction for this source-evidence conflict is missing.");
      }
      const { rows: transactionRows } = await client.query<CanonicalTransactionRow>(
        `SELECT imported_hours::text, imported_rate::text, imported_amount::text,
                pay_to_raw, total_net_pay::text, import_row_id
           FROM payroll_transactions WHERE id = $1 FOR UPDATE`,
        [conflict.payroll_transaction_id],
      );
      const transaction = transactionRows[0];
      if (!transaction) return fail("not_found", "That transaction no longer exists.");
      const audited = await transactionHasAuditedCorrection(client, transaction.import_row_id);

      const { rows: trackingRows } = await client.query<TrackingRow>(
        `SELECT id, source_row_number, identity
           FROM sheet_sync_rows WHERE payroll_transaction_id = $1 FOR UPDATE`,
        [conflict.payroll_transaction_id],
      );
      const tracking = trackingRows[0];
      if (!tracking) {
        throw new Error("The sync tracking row for this conflict is missing; no evidence was accepted.");
      }
      const adopted = adoptedTrackingEvidence(tracking.identity, conflict.incoming, tracking.source_row_number);
      await client.query(
        `UPDATE sheet_sync_rows
            SET source_row_number = $2, identity = $3::jsonb, updated_at = now()
          WHERE id = $1`,
        [tracking.id, adopted.sourceRowNumber, JSON.stringify(adopted.identity)],
      );

      canonicalChangeRetained = hasCanonicalChange(transaction, jsonRecord(conflict.incoming));
      await closeConflict(
        client,
        conflictId,
        "dismissed",
        "source_evidence_adopted",
        actorId,
        note ?? "Accepted the current Pay-To / Total Net Pay source evidence without changing transaction values.",
      );
      if (canonicalChangeRetained) {
        await retainCanonicalConflict(client, conflict, transaction, audited);
      }
    } else if (conflict.payroll_transaction_id && conflict.type === "changed") {
      const incoming = jsonRecord(conflict.incoming);
      const fingerprint = conflictSourceFingerprint(incoming);
      if (!fingerprint) {
        return fail(
          "validation",
          "The current source fingerprint is unavailable, so this change cannot be acknowledged safely.",
        );
      }
      const { rows: trackingRows } = await client.query<TrackingRow>(
        `SELECT id, source_row_number, identity
           FROM sheet_sync_rows WHERE payroll_transaction_id = $1 FOR UPDATE`,
        [conflict.payroll_transaction_id],
      );
      const tracking = trackingRows[0];
      if (!tracking) {
        throw new Error("The sync tracking row for this conflict is missing; no source change was acknowledged.");
      }
      const incomingSourceRow = nonNegativeInteger(incoming.sourceRowNumber);
      const sourceRowNumber = incomingSourceRow && incomingSourceRow > 0
        ? incomingSourceRow
        : tracking.source_row_number;
      const occurrence = sourceOccurrenceEvidenceFromIdentity(incoming, sourceRowNumber);
      const evidenceKey = sourceEvidenceKey(incoming);
      const evidenceKeys = normalizedSourceEvidenceKeys(
        Array.isArray(incoming.sourceEvidenceKeys)
          ? incoming.sourceEvidenceKeys
          : evidenceKey ? [evidenceKey] : [],
      );
      const acceptedIdentity = {
        ...incoming,
        ...occurrence,
        sourceEvidenceKeyVersion: SOURCE_EVIDENCE_KEY_VERSION,
        sourceEvidenceKeys: evidenceKeys,
      };
      await client.query(
        `UPDATE sheet_sync_rows
            SET natural_key = $2, fingerprint = $3, source_row_number = $4,
                identity = $5::jsonb, state = 'active', last_seen_at = now(), updated_at = now()
          WHERE id = $1`,
        [tracking.id, conflict.natural_key, fingerprint, sourceRowNumber, JSON.stringify(acceptedIdentity)],
      );
      canonicalSourceAccepted = true;
      await closeConflict(
        client,
        conflictId,
        "dismissed",
        "source_change_acknowledged",
        actorId,
        note ?? "Kept the existing Neon transaction and acknowledged this exact current Sheet source value.",
      );
    } else if (conflict.payroll_transaction_id && conflict.type === "missing") {
      const incoming = jsonRecord(conflict.incoming);
      const currentCount = nonNegativeInteger(incoming.sourceOccurrenceCount) ?? 0;
      const { rows: trackingRows } = await client.query<TrackingRow>(
        `SELECT id, source_row_number, identity
           FROM sheet_sync_rows WHERE payroll_transaction_id = $1 FOR UPDATE`,
        [conflict.payroll_transaction_id],
      );
      const tracking = trackingRows[0];
      if (!tracking) {
        throw new Error("The sync tracking row for this conflict is missing; no missing evidence was acknowledged.");
      }

      if (currentCount === 0) {
        acceptedWholeMissing = true;
        await client.query(
          `UPDATE sheet_sync_rows
              SET identity = $2::jsonb, state = 'accepted_missing', updated_at = now()
            WHERE id = $1`,
          [tracking.id, JSON.stringify({ ...jsonRecord(tracking.identity), sourceMissingAccepted: true })],
        );
      } else {
        const occurrence = sourceOccurrenceEvidenceFromIdentity(incoming, tracking.source_row_number);
      const acceptedIdentity: Record<string, unknown> = {
        ...jsonRecord(tracking.identity),
        ...incoming,
        ...occurrence,
      };
        delete acceptedIdentity.sourceMissingAccepted;
        await client.query(
          `UPDATE sheet_sync_rows
              SET source_row_number = $2, identity = $3::jsonb, state = 'active', updated_at = now()
            WHERE id = $1`,
          [tracking.id, occurrence.sourceRowNumbers[0] ?? tracking.source_row_number, JSON.stringify(acceptedIdentity)],
        );
      }
      await closeConflict(
        client,
        conflictId,
        "dismissed",
        currentCount === 0 ? "accepted_missing" : "source_occurrence_count_accepted",
        actorId,
        note ?? (currentCount === 0
          ? "Kept the existing Neon transaction and acknowledged that its source row is currently absent."
          : "Kept the existing Neon transaction and acknowledged the current lower source occurrence count."),
      );
    } else {
      await closeConflict(client, conflictId, "dismissed", "dismissed", actorId, note ?? null);
    }

    if (conflict.payroll_transaction_id) {
      await recomputeOpenConflictState(
        client,
        conflict.payroll_transaction_id,
        acceptedWholeMissing ? "accepted_missing" : "active",
      );
    }
    await recordChange(client, {
      actorId,
      action: "sheet_sync_conflict_dismissed",
      entityType: "sheet_sync_conflict",
      entityId: conflictId,
      extra: {
        type: conflict.type,
        sourceEvidenceAdopted: sourceEvidence,
        canonicalChangeRetained,
        canonicalSourceAccepted,
        acceptedWholeMissing,
      },
    });
    return ok({ id: conflictId });
  });
}

async function closeConflict(
  db: Queryable,
  id: string,
  status: string,
  resolution: string,
  actorId: string | null,
  note: string | null,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE sheet_sync_conflicts
        SET status = $2, resolution = $3, resolution_note = $4, resolved_by_user_id = $5,
            resolved_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING id`,
    [id, status, resolution, note, actorId],
  );
  if (!rows[0]) {
    throw new Error("The sync conflict changed while it was being resolved; no resolution was saved.");
  }
}
