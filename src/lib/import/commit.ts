import { dec, toMoney, toHours } from "@/lib/money";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";
import {
  rateConfigForStagedRow,
  type StagingResult,
  type StagedRow,
  type RateConfig,
} from "./stage";
import { evaluateRateException } from "@/lib/business/rate-exceptions";
import { normalizePersonName } from "@/lib/business/name-matching";
import { backfillPaymentAttribution } from "@/lib/manage/payment-attribution";
import { acquireSettlementSourceLock } from "@/lib/manage/settlement-freshness";

/**
 * IMPORT COMMIT
 * =============
 *
 * The only place in the system that writes business records from a workbook.
 *
 * Guarantees
 * ----------
 *  1. ONE transaction. Every insert below either lands together or not at all.
 *     A half-imported workbook is worse than a failed import, because the
 *     totals look plausible.
 *  2. IDEMPOTENT. Committing the same imported_file twice is a no-op that
 *     returns the first commit's summary. Serialised with a transaction-scoped
 *     advisory lock keyed on the file checksum, so two concurrent requests
 *     cannot both pass the "already committed?" check.
 *  3. NOTHING IS DISCARDED. Every parsed source row becomes an import_rows
 *     record, whatever its status. Only rows staged as `valid` become payroll
 *     transactions.
 *
 * Review rows
 * -----------
 * A row staged `needs_review` (unknown program, unmatched individual,
 * ambiguous name) is preserved in import_rows with its full raw values and its
 * warnings, and does NOT become a payroll transaction. That is deliberate:
 * a payroll transaction with a null program is invisible to budget utilization
 * but still counts toward money totals, which is exactly the misleading
 * half-record the previous implementation created. Review rows are surfaced in
 * the exceptions area, and are committed as transactions only after a human
 * resolves every match and explicitly applies the corrected row. That guarded
 * operation preserves the source, refuses group/duplicate ambiguity, and
 * creates the ledger transaction and service allocation atomically.
 */

/* -------------------------------------------------------------------------- */
/* Minimal pg-compatible surface                                              */
/* -------------------------------------------------------------------------- */

/**
 * The subset of node-postgres / @neondatabase/serverless we depend on.
 *
 * Declared structurally rather than importing Pool so that the commit path can
 * be driven by a real Neon pool in production and by a plain `pg` pool in the
 * PostgreSQL integration tests, with no test-only rewrite of this module.
 */
export interface PgLikeResult<T> {
  rows: T[];
  rowCount?: number | null;
}

export interface PgLikeClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PgLikeResult<T>>;
  release(): void;
}

export interface PgLikePool {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PgLikeResult<T>>;
  connect(): Promise<PgLikeClient>;
}

/* -------------------------------------------------------------------------- */
/* Inputs and outputs                                                         */
/* -------------------------------------------------------------------------- */

export interface CommitInput {
  /** SHA-256 of the uploaded bytes. The file-level duplicate guard. */
  checksumSha256: string;
  originalFilename: string;
  byteSize: number;
  templateDetected: string;
  /** Slim metadata written to imported_files.sheet_summary after commit. */
  sheetSummary: Record<string, unknown>;
  /** Every parsed source row, valid or not. */
  parsedRows: ParsedAhivimRow[];
  /** The staging analysis these rows produced against current database state. */
  staging: StagingResult;
  /** Effective-dated rates used during staging, for rate-exception records. */
  ratesByProgram: Record<string, RateConfig>;
  committedByUserId: string | null;
}

export interface CommitCounts {
  sourceRows: number;
  importRows: number;
  transactions: number;
  serviceSessions: number;
  serviceAllocations: number;
  individualsCreated: number;
  employeesCreated: number;
  rateExceptions: number;
  warnings: number;
  reviewRows: number;
  invalidRows: number;
  duplicateRows: number;
}

export interface CommitResult {
  alreadyCommitted: boolean;
  importedFileId: string;
  importBatchId: string;
  counts: CommitCounts;
  reconciliation: StagingResult["reconciliation"];
  /** Human-readable statement of what was and was not written. */
  note: string;
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                     */
/* -------------------------------------------------------------------------- */

export async function commitStagedImport(
  pool: PgLikePool,
  input: CommitInput,
): Promise<CommitResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await acquireSettlementSourceLock(client);

    // Serialise concurrent commits of the same file. Transaction-scoped, so it
    // is released by COMMIT or ROLLBACK without any explicit unlock.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.checksumSha256]);

    const existing = await findCommittedBatch(client, input.checksumSha256);
    if (existing) {
      await client.query("COMMIT");
      return {
        alreadyCommitted: true,
        importedFileId: existing.imported_file_id,
        importBatchId: existing.id,
        counts: emptyCounts(input),
        reconciliation: input.staging.reconciliation,
        note:
          "This workbook has already been committed. Nothing was written. " +
          "The existing import batch is returned unchanged.",
      };
    }

    const result = await writeImport(client, input);
    await client.query("COMMIT");

    // Attribute payments (recipient / employee amount / agency additional) for
    // the freshly-committed batch. Runs AFTER commit so a hiccup here never
    // rolls back a good import; it only writes the three attribution columns and
    // never the imported figures. A re-import returns early above with
    // alreadyCommitted=true and writes nothing, so attribution is never doubled.
    try {
      await backfillPaymentAttribution(pool, { batchId: result.importBatchId }, input.committedByUserId);
    } catch {
      /* attribution is derived, re-runnable data; a failure must not fail the import */
    }
    return result;
  } catch (error) {
    // A failed COMMIT leaves the transaction aborted; ROLLBACK is still correct
    // and its own failure must not mask the original error.
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the original error is the one worth reporting */
    }
    throw new Error(
      `Import commit failed and was rolled back. No records were written. Cause: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  } finally {
    client.release();
  }
}

async function findCommittedBatch(
  client: PgLikeClient,
  checksum: string,
): Promise<{ id: string; imported_file_id: string } | null> {
  const { rows } = await client.query<{ id: string; imported_file_id: string }>(
    `SELECT b.id, b.imported_file_id
       FROM import_batches b
       JOIN imported_files f ON f.id = b.imported_file_id
      WHERE f.checksum_sha256 = $1 AND b.status = 'committed'
      LIMIT 1`,
    [checksum],
  );
  return rows[0] ?? null;
}

/**
 * Rows per multi-row INSERT/UPDATE statement. Large enough that a commit costs
 * ceil(sheet_size / CHUNK_SIZE) round-trips instead of one per row, small enough
 * that a single statement's parameter arrays and locks stay modest. Matches the
 * chunk size the sheet-sync tracking upsert already uses.
 */
const CHUNK_SIZE = 500;

/** Column values for one batched import_rows insert. */
interface ImportRowInsert {
  sourceRowNumber: number;
  rawValues: string;
  status: string;
  validationErrors: string | null;
  resolvedIndividualId: string | null;
  resolvedEmployeeId: string | null;
  resolvedProgramId: string | null;
  fingerprint: string | null;
}

/** Column values for one batched payroll_transactions insert. */
interface TxnInsert {
  sourceRowNumber: number;
  importRowId: string | null;
  payTo: string | null;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  individualId: string | null;
  employeeId: string | null;
  programId: string | null;
  individualRaw: string;
  employeeRaw: string | null;
  programRaw: string;
  importedHours: string;
  importedRate: string;
  importedAmount: string;
  totalNetPay: string | null;
  spreadsheetInternalAmount: string | null;
  calculatedInternalAmount: string | null;
  internalRateApplied: string | null;
  agencyRateApplied: string | null;
  internalAmountMismatch: string;
  fingerprint: string | null;
  duplicateStatus: string;
}

/** Column values for one batched service_sessions insert. */
interface SessionInsert {
  signature: string;
  employeeId: string | null;
  programId: string | null;
  checkNumber: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  physicalHours: string;
  groupSize: number;
  combinedRate: string | null;
  combinedAmount: string | null;
  baseIndividualRate: string | null;
  status: string;
  detectionRule: string;
  confidence: string;
  validation: string;
  warningReason: string | null;
  sourceRowRefs: string;
}

/** Column values for one batched service_allocations insert. */
interface AllocationInsert {
  sessionId: string;
  individualId: string;
  txId: string | null;
  hours: string;
  rate: string;
  amount: string;
  rounding: string;
}

/** Column values for one batched import_warnings insert. */
interface WarningInsert {
  importRowId: string | null;
  individualId: string | null;
  category: string;
  severity: string;
  message: string;
  details: string | null;
}

/** Column values for one batched rate_exceptions insert. */
interface RateExceptionInsert {
  payrollTransactionId: string | null;
  individualId: string | null;
  programId: string | null;
  importedRate: string;
  expectedRate: string;
  varianceAmount: string;
  variancePercent: string;
  direction: string;
  note: string;
}

async function writeImport(client: PgLikeClient, input: CommitInput): Promise<CommitResult> {
  const { staging, parsedRows } = input;

  /* ---- 1. imported_files ------------------------------------------------- */
  const fileRows = await client.query<{ id: string }>(
    `INSERT INTO imported_files
       (original_filename, byte_size, checksum_sha256, uploaded_by_user_id,
        template_detected, sheet_summary)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (checksum_sha256) DO UPDATE
       SET sheet_summary = EXCLUDED.sheet_summary, updated_at = now()
     RETURNING id`,
    [
      input.originalFilename,
      input.byteSize,
      input.checksumSha256,
      input.committedByUserId,
      input.templateDetected,
      JSON.stringify(input.sheetSummary),
    ],
  );
  const importedFileId = fileRows.rows[0].id;

  /* ---- 2. import_batches -------------------------------------------------- */
  const batchRows = await client.query<{ id: string }>(
    `INSERT INTO import_batches
       (imported_file_id, status, started_by_user_id, committed_by_user_id, committed_at,
        total_rows, valid_rows, duplicate_rows, warning_rows, error_rows,
        source_agency_gross, imported_agency_gross,
        source_internal_amount, imported_internal_amount, reconciliation_notes)
     VALUES ($1, 'committed', $2, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      importedFileId,
      input.committedByUserId,
      staging.totalSourceRows,
      staging.counts.valid,
      staging.counts.duplicates,
      staging.counts.warningRows,
      staging.counts.invalid,
      staging.reconciliation.workbookAgencyGross,
      staging.reconciliation.importedAgencyGross,
      staging.reconciliation.workbookInternalAmount,
      staging.reconciliation.importedInternalAmount,
      staging.reconciliation.note,
    ],
  );
  const importBatchId = batchRows.rows[0].id;

  /* ---- 3. canonical people ------------------------------------------------ */
  //
  // Only rows that will actually become transactions create canonical people.
  // A `needs_review` row must not silently mint an individual: that is how an
  // unresolved misspelling becomes a permanent second record.
  const stagedByRow = new Map<number, StagedRow>(staging.rows.map((r) => [r.sourceRowNumber, r]));
  const parsedByRow = new Map<number, ParsedAhivimRow>(
    parsedRows.map((r) => [r.sourceRowNumber, r]),
  );

  const individualNames = new Map<string, string>();
  const employeeNames = new Map<string, string>();
  for (const staged of staging.rows) {
    if (staged.status !== "valid") continue;
    const parsed = parsedByRow.get(staged.sourceRowNumber)?.parsed;
    if (!parsed) continue;
    const iKey = normalizePersonName(parsed.individual);
    if (iKey) individualNames.set(iKey, parsed.individual.trim());
    const eKey = normalizePersonName(parsed.employee);
    if (eKey) employeeNames.set(eKey, parsed.employee.trim());
  }

  const individuals = await upsertPeople(client, "individuals", individualNames);
  const employees = await upsertPeople(client, "employees", employeeNames);

  /* ---- 4. programs -------------------------------------------------------- */
  const { rows: programRows } = await client.query<{ id: string; code: string }>(
    `SELECT id, code FROM programs`,
  );
  const programIds = new Map(programRows.map((p) => [p.code, p.id]));

  /* ---- 5. import_rows: EVERY source row, nothing discarded ---------------- */
  //
  // Batched: one chunked multi-row INSERT per CHUNK_SIZE rows instead of one
  // round-trip per source row. Column values, raw_values JSON, resolved ids,
  // fingerprints and statuses are exactly what the per-row insert produced;
  // RETURNING id, source_row_number rebuilds the row -> id map order-independently
  // (source_row_number is unique within a batch).
  const importRowIds = new Map<number, string>();

  const importRowValues: ImportRowInsert[] = parsedRows.map((parsed) => {
    const staged = stagedByRow.get(parsed.sourceRowNumber);
    const status = staged?.status ?? "invalid";
    const iKey = parsed.parsed ? normalizePersonName(parsed.parsed.individual) : "";
    const eKey = parsed.parsed ? normalizePersonName(parsed.parsed.employee) : "";
    return {
      sourceRowNumber: parsed.sourceRowNumber,
      rawValues: JSON.stringify({ raw: parsed.raw, formulas: parsed.formulas }),
      status: status === "valid" ? "imported" : status,
      validationErrors: parsed.errors.length ? JSON.stringify(parsed.errors) : null,
      resolvedIndividualId: status === "valid" ? (individuals.get(iKey) ?? null) : null,
      resolvedEmployeeId: status === "valid" ? (employees.get(eKey) ?? null) : null,
      resolvedProgramId: staged?.programCode ? (programIds.get(staged.programCode) ?? null) : null,
      fingerprint: staged?.fingerprint ?? null,
    };
  });

  for (let i = 0; i < importRowValues.length; i += CHUNK_SIZE) {
    const chunk = importRowValues.slice(i, i + CHUNK_SIZE);
    const { rows } = await client.query<{ id: string; source_row_number: number }>(
      `INSERT INTO import_rows
         (import_batch_id, sheet_name, source_row_number, raw_values, status,
          validation_errors, resolved_individual_id, resolved_employee_id,
          resolved_program_id, transaction_fingerprint)
       SELECT $1::uuid, 'Ahivim', srn, rv::jsonb, st, ve::jsonb,
              ri::uuid, re::uuid, rp::uuid, tf
         FROM unnest($2::int[], $3::text[], $4::text[], $5::text[],
                     $6::text[], $7::text[], $8::text[], $9::text[])
              AS t(srn, rv, st, ve, ri, re, rp, tf)
       RETURNING id, source_row_number`,
      [
        importBatchId,
        chunk.map((v) => v.sourceRowNumber),
        chunk.map((v) => v.rawValues),
        chunk.map((v) => v.status),
        chunk.map((v) => v.validationErrors),
        chunk.map((v) => v.resolvedIndividualId),
        chunk.map((v) => v.resolvedEmployeeId),
        chunk.map((v) => v.resolvedProgramId),
        chunk.map((v) => v.fingerprint),
      ],
    );
    for (const r of rows) importRowIds.set(r.source_row_number, r.id);
  }

  /* ---- 6. payroll_transactions: VALID rows only --------------------------- */
  //
  // Batched the same way. There is no ON CONFLICT and no unique constraint on any
  // batched column (the fingerprint index is non-unique) — duplicate detection
  // already happened in staging — so a chunked multi-row INSERT stores exactly
  // the same rows the per-row loop did. RETURNING id, source_row_number rebuilds
  // the row -> id map.
  const transactionIds = new Map<number, string>();

  const txnValues = staging.rows.flatMap((staged): TxnInsert[] => {
    if (staged.status !== "valid") return [];
    const parsed = parsedByRow.get(staged.sourceRowNumber);
    if (!parsed?.parsed) return [];
    const p = parsed.parsed;
    // Production staging resolves the full effective-dated catalog for this
    // row's canonical service date. The fallback keeps older fixtures and
    // callers that construct StagedRow objects directly source-compatible.
    const rate = rateConfigForStagedRow(
      staged,
      staged.programCode ? input.ratesByProgram[staged.programCode] : undefined,
    );
    return [
      {
        sourceRowNumber: staged.sourceRowNumber,
        importRowId: importRowIds.get(staged.sourceRowNumber) ?? null,
        payTo: p.payTo || null,
        checkNumber: p.checkNumber || null,
        checkDate: p.checkDate || null,
        periodBegin: p.periodBegin || null,
        periodEnd: p.periodEnd || null,
        individualId: individuals.get(normalizePersonName(p.individual)) ?? null,
        employeeId: employees.get(normalizePersonName(p.employee)) ?? null,
        programId: staged.programCode ? (programIds.get(staged.programCode) ?? null) : null,
        individualRaw: p.individual,
        employeeRaw: p.employee || null,
        programRaw: p.programDescription,
        importedHours: toHours(p.hours),
        importedRate: toMoney(p.rate),
        importedAmount: toMoney(p.amount),
        totalNetPay: p.totalNetPay ? toMoney(p.totalNetPay) : null,
        spreadsheetInternalAmount: staged.spreadsheetInternalAmount,
        calculatedInternalAmount: staged.calculatedInternalAmount,
        internalRateApplied: rate?.internalRate ?? null,
        agencyRateApplied: rate?.agencyRate ?? null,
        internalAmountMismatch: staged.internalAmountMismatch ? "true" : "false",
        fingerprint: staged.fingerprint,
        duplicateStatus: staged.duplicateStatus,
      },
    ];
  });

  for (let i = 0; i < txnValues.length; i += CHUNK_SIZE) {
    const chunk = txnValues.slice(i, i + CHUNK_SIZE);
    const { rows } = await client.query<{ id: string; source_row_number: number }>(
      `INSERT INTO payroll_transactions
         (import_batch_id, import_row_id, source_file_id, source_row_number,
          pay_to_raw, check_number, check_date, period_begin, period_end,
          individual_id, employee_id, program_id,
          individual_raw, employee_raw, program_raw,
          imported_hours, imported_rate, imported_amount, total_net_pay,
          spreadsheet_internal_amount, calculated_internal_amount,
          internal_rate_applied, agency_rate_applied, internal_amount_mismatch,
          transaction_fingerprint, duplicate_status)
       SELECT $1::uuid, irid::uuid, $2::uuid, srn,
              payto, chkno, chkdt::date, pb::date, pe::date,
              indid::uuid, empid::uuid, progid::uuid,
              indraw, empraw, prograw,
              hrs::numeric, rate::numeric, amt::numeric, tnp::numeric,
              sia::numeric, cia::numeric,
              ira::numeric, ara::numeric, mismatch::boolean,
              fp, dupst
         FROM unnest($3::uuid[], $4::int[], $5::text[], $6::text[], $7::text[],
                     $8::text[], $9::text[], $10::uuid[], $11::uuid[], $12::uuid[],
                     $13::text[], $14::text[], $15::text[], $16::text[], $17::text[],
                     $18::text[], $19::text[], $20::text[], $21::text[], $22::text[],
                     $23::text[], $24::text[], $25::text[], $26::text[])
              AS t(irid, srn, payto, chkno, chkdt, pb, pe, indid, empid, progid,
                   indraw, empraw, prograw, hrs, rate, amt, tnp, sia, cia,
                   ira, ara, mismatch, fp, dupst)
       RETURNING id, source_row_number`,
      [
        importBatchId,
        importedFileId,
        chunk.map((v) => v.importRowId),
        chunk.map((v) => v.sourceRowNumber),
        chunk.map((v) => v.payTo),
        chunk.map((v) => v.checkNumber),
        chunk.map((v) => v.checkDate),
        chunk.map((v) => v.periodBegin),
        chunk.map((v) => v.periodEnd),
        chunk.map((v) => v.individualId),
        chunk.map((v) => v.employeeId),
        chunk.map((v) => v.programId),
        chunk.map((v) => v.individualRaw),
        chunk.map((v) => v.employeeRaw),
        chunk.map((v) => v.programRaw),
        chunk.map((v) => v.importedHours),
        chunk.map((v) => v.importedRate),
        chunk.map((v) => v.importedAmount),
        chunk.map((v) => v.totalNetPay),
        chunk.map((v) => v.spreadsheetInternalAmount),
        chunk.map((v) => v.calculatedInternalAmount),
        chunk.map((v) => v.internalRateApplied),
        chunk.map((v) => v.agencyRateApplied),
        chunk.map((v) => v.internalAmountMismatch),
        chunk.map((v) => v.fingerprint),
        chunk.map((v) => v.duplicateStatus),
      ],
    );
    for (const r of rows) transactionIds.set(r.source_row_number, r.id);
  }

  /* ---- 7. service sessions and equal allocations -------------------------- */
  //
  // A session stores the employee's PHYSICAL hours once. Each allocation gets
  // those same full hours and an equal share of the money. Buckets staged
  // `needs_review` produce no allocations and are recorded as sessions awaiting
  // a decision, so the money is never quietly split on a guess.
  //
  // Batched in three phases that preserve the per-row semantics exactly:
  //   (a) one chunked INSERT of every session, RETURNING id + detection_signature.
  //       detectGroups buckets rows by signature, so every group has a distinct
  //       signature and the signature -> id map is unambiguous.
  //   (b) one chunked UPDATE stamping each member transaction with its session id
  //       and group flag.
  //   (c) one chunked INSERT of every allocation, keeping the identical
  //       ON CONFLICT (service_session_id, individual_id) DO NOTHING guard. No
  //       (session, individual) pair repeats across the batch — session ids are
  //       unique per group and a detected group's individuals are distinct — so
  //       the conflict behaviour and the counted allocations are unchanged.
  let sessionCount = 0;
  let allocationCount = 0;

  const groupsToWrite = staging.groups
    .map((group) => ({
      group,
      memberRows: group.sourceRowRefs
        .map((n) => ({ n, staged: stagedByRow.get(n), parsed: parsedByRow.get(n)?.parsed }))
        .filter((m) => m.staged?.status === "valid" && m.parsed),
    }))
    .filter((g) => g.memberRows.length > 0);

  const sessionValues: SessionInsert[] = groupsToWrite.map(({ group, memberRows }) => {
    const lead = memberRows[0];
    return {
      signature: group.signature,
      employeeId: employees.get(normalizePersonName(lead.parsed!.employee)) ?? null,
      programId: lead.staged!.programCode ? (programIds.get(lead.staged!.programCode) ?? null) : null,
      checkNumber: lead.parsed!.checkNumber || null,
      periodBegin: lead.parsed!.periodBegin || null,
      periodEnd: lead.parsed!.periodEnd || null,
      physicalHours: group.physicalHours,
      groupSize: group.groupSize,
      combinedRate: group.combinedRate,
      combinedAmount: group.combinedAmount,
      baseIndividualRate: group.baseIndividualRate,
      status: group.status,
      detectionRule: group.detectionRule,
      confidence: group.confidence,
      validation: JSON.stringify(group.validation),
      warningReason: group.warningReason,
      sourceRowRefs: JSON.stringify(group.sourceRowRefs),
    };
  });

  const sessionIdBySignature = new Map<string, string>();
  for (let i = 0; i < sessionValues.length; i += CHUNK_SIZE) {
    const chunk = sessionValues.slice(i, i + CHUNK_SIZE);
    const { rows } = await client.query<{ id: string; detection_signature: string }>(
      `INSERT INTO service_sessions
         (import_batch_id, employee_id, program_id, check_number, period_begin, period_end,
          physical_hours, group_size, combined_rate, combined_amount, base_individual_rate,
          group_detection_status, detection_rule, detection_signature, confidence,
          validation_result, warning_reason, source_row_refs)
       SELECT $1::uuid, empid::uuid, progid::uuid, chkno, pb::date, pe::date,
              ph::numeric, gsize, crate::numeric, camt::numeric, birate::numeric,
              gstatus, drule, sig, conf::numeric,
              vres::jsonb, wreason, refs::jsonb
         FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[],
                     $7::text[], $8::int[], $9::text[], $10::text[], $11::text[],
                     $12::text[], $13::text[], $14::text[], $15::text[],
                     $16::text[], $17::text[], $18::text[])
              AS t(empid, progid, chkno, pb, pe, ph, gsize, crate, camt, birate,
                   gstatus, drule, sig, conf, vres, wreason, refs)
       RETURNING id, detection_signature`,
      [
        importBatchId,
        chunk.map((v) => v.employeeId),
        chunk.map((v) => v.programId),
        chunk.map((v) => v.checkNumber),
        chunk.map((v) => v.periodBegin),
        chunk.map((v) => v.periodEnd),
        chunk.map((v) => v.physicalHours),
        chunk.map((v) => v.groupSize),
        chunk.map((v) => v.combinedRate),
        chunk.map((v) => v.combinedAmount),
        chunk.map((v) => v.baseIndividualRate),
        chunk.map((v) => v.status),
        chunk.map((v) => v.detectionRule),
        chunk.map((v) => v.signature),
        chunk.map((v) => v.confidence),
        chunk.map((v) => v.validation),
        chunk.map((v) => v.warningReason),
        chunk.map((v) => v.sourceRowRefs),
      ],
    );
    for (const r of rows) sessionIdBySignature.set(r.detection_signature, r.id);
    sessionCount += rows.length;
  }

  // Phases (b) and (c): walk the members once, in the same order as before, to
  // build the transaction-stamp updates and the allocation rows. allocationCount
  // is incremented for exactly the same members the per-row loop counted.
  const txStamps: { txId: string; sessionId: string; isGroup: string }[] = [];
  const allocationValues: AllocationInsert[] = [];
  for (const { group, memberRows } of groupsToWrite) {
    const sessionId = sessionIdBySignature.get(group.signature);
    if (!sessionId) continue; // every written session returned its id; defensive only
    const isGroup = group.groupSize > 1 && group.status === "detected";
    for (const member of memberRows) {
      const txId = transactionIds.get(member.n) ?? null;
      if (txId) txStamps.push({ txId, sessionId, isGroup: isGroup ? "true" : "false" });

      const allocation = group.allocations.find((a) => a.importRowId === `row-${member.n}`);
      if (!allocation) continue; // needs_review buckets produce no allocations

      const individualId = individuals.get(normalizePersonName(member.parsed!.individual));
      if (!individualId) continue;

      allocationValues.push({
        sessionId,
        individualId,
        txId,
        hours: allocation.allocationHours,
        rate: allocation.allocatedRate,
        amount: allocation.allocatedAmount,
        rounding: allocation.roundingAdjustment,
      });
      allocationCount++;
    }
  }

  for (let i = 0; i < txStamps.length; i += CHUNK_SIZE) {
    const chunk = txStamps.slice(i, i + CHUNK_SIZE);
    await client.query(
      `UPDATE payroll_transactions AS t
          SET service_session_id = u.sid::uuid,
              is_group_service = u.grp::boolean,
              updated_at = now()
         FROM unnest($1::uuid[], $2::uuid[], $3::text[]) AS u(tid, sid, grp)
        WHERE t.id = u.tid::uuid`,
      [chunk.map((v) => v.txId), chunk.map((v) => v.sessionId), chunk.map((v) => v.isGroup)],
    );
  }

  for (let i = 0; i < allocationValues.length; i += CHUNK_SIZE) {
    const chunk = allocationValues.slice(i, i + CHUNK_SIZE);
    await client.query(
      `INSERT INTO service_allocations
         (service_session_id, individual_id, payroll_transaction_id,
          allocation_hours, allocated_rate, allocated_amount, rounding_adjustment)
       SELECT sid::uuid, iid::uuid, tid::uuid, hrs::numeric, rate::numeric, amt::numeric, adj::numeric
         FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS u(sid, iid, tid, hrs, rate, amt, adj)
       ON CONFLICT (service_session_id, individual_id) DO NOTHING`,
      [
        chunk.map((v) => v.sessionId),
        chunk.map((v) => v.individualId),
        chunk.map((v) => v.txId),
        chunk.map((v) => v.hours),
        chunk.map((v) => v.rate),
        chunk.map((v) => v.amount),
        chunk.map((v) => v.rounding),
      ],
    );
  }

  /* ---- 8. warnings, rate exceptions --------------------------------------- */
  //
  // Batched into two chunked INSERTs. Both tables are append-only with no unique
  // constraint on the inserted columns, so multi-row inserts store exactly what
  // the per-row loop did. The rate-exception variance is still recomputed per row
  // from the same inputs staging used (evaluateRateException is pure), before the
  // batch, so the stored figures are unchanged. import_warnings has no dependency
  // on rate_exceptions (and vice versa), so writing all warnings then all rate
  // exceptions is equivalent to the old interleaved order.
  const warningValues: WarningInsert[] = staging.warnings.map((warning) => {
    const rowId =
      warning.sourceRowNumber !== null
        ? (importRowIds.get(warning.sourceRowNumber) ?? null)
        : null;
    const parsed =
      warning.sourceRowNumber !== null
        ? parsedByRow.get(warning.sourceRowNumber)?.parsed
        : undefined;
    return {
      importRowId: rowId,
      individualId: parsed
        ? (individuals.get(normalizePersonName(parsed.individual)) ?? null)
        : null,
      category: warning.category,
      severity: warning.severity,
      message: warning.message,
      details: warning.details ? JSON.stringify(warning.details) : null,
    };
  });

  for (let i = 0; i < warningValues.length; i += CHUNK_SIZE) {
    const chunk = warningValues.slice(i, i + CHUNK_SIZE);
    await client.query(
      `INSERT INTO import_warnings
         (import_batch_id, import_row_id, individual_id, category, severity, message, details)
       SELECT $1::uuid, rid::uuid, iid::uuid, cat, sev, msg, det::jsonb
         FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS t(rid, iid, cat, sev, msg, det)`,
      [
        importBatchId,
        chunk.map((v) => v.importRowId),
        chunk.map((v) => v.individualId),
        chunk.map((v) => v.category),
        chunk.map((v) => v.severity),
        chunk.map((v) => v.message),
        chunk.map((v) => v.details),
      ],
    );
  }

  const rateExceptionValues = staging.warnings.flatMap((warning): RateExceptionInsert[] => {
    if (warning.sourceRowNumber === null) return [];
    const staged = stagedByRow.get(warning.sourceRowNumber);
    const parsed = parsedByRow.get(warning.sourceRowNumber)?.parsed;
    if (warning.category !== "rate_exception" || !parsed || !staged?.programCode) return [];

    // Recompute the variance from the same inputs staging used, so the stored
    // exception carries the actual imported and expected rates rather than a
    // re-derived guess.
    const config = rateConfigForStagedRow(staged, input.ratesByProgram[staged.programCode]);
    const payrollTransactionId = transactionIds.get(staged.sourceRowNumber) ?? null;
    if (!config || !payrollTransactionId) return [];
    const evaluated = evaluateRateException({
      importedRate: parsed.rate,
      expectedRate: config.internalRate,
    });
    return [
      {
        payrollTransactionId,
        individualId: individuals.get(normalizePersonName(parsed.individual)) ?? null,
        programId: programIds.get(staged.programCode) ?? null,
        importedRate: evaluated.importedRate,
        expectedRate: evaluated.expectedRate,
        varianceAmount: evaluated.varianceAmount,
        variancePercent: evaluated.variancePercent,
        direction: evaluated.direction === "match" ? "higher" : evaluated.direction,
        note: evaluated.summary,
      },
    ];
  });
  const rateExceptionCount = rateExceptionValues.length;

  for (let i = 0; i < rateExceptionValues.length; i += CHUNK_SIZE) {
    const chunk = rateExceptionValues.slice(i, i + CHUNK_SIZE);
    await client.query(
      `INSERT INTO rate_exceptions
         (import_batch_id, payroll_transaction_id, individual_id, program_id,
          imported_rate, expected_rate, variance_amount, variance_percent, direction, note)
       SELECT $1::uuid, tid::uuid, iid::uuid, pid::uuid,
              irate::numeric, erate::numeric, vamt::numeric, vpct::numeric, dir, note
         FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[],
                     $7::text[], $8::text[], $9::text[], $10::text[])
              AS t(tid, iid, pid, irate, erate, vamt, vpct, dir, note)`,
      [
        importBatchId,
        chunk.map((v) => v.payrollTransactionId),
        chunk.map((v) => v.individualId),
        chunk.map((v) => v.programId),
        chunk.map((v) => v.importedRate),
        chunk.map((v) => v.expectedRate),
        chunk.map((v) => v.varianceAmount),
        chunk.map((v) => v.variancePercent),
        chunk.map((v) => v.direction),
        chunk.map((v) => v.note),
      ],
    );
  }

  /* ---- 9. counts and audit ------------------------------------------------ */
  const counts: CommitCounts = {
    sourceRows: parsedRows.length,
    importRows: importRowIds.size,
    transactions: transactionIds.size,
    serviceSessions: sessionCount,
    serviceAllocations: allocationCount,
    individualsCreated: individuals.size,
    employeesCreated: employees.size,
    rateExceptions: rateExceptionCount,
    warnings: staging.warnings.length,
    reviewRows: staging.counts.needsReview,
    invalidRows: staging.counts.invalid,
    duplicateRows: staging.counts.confirmedDuplicates,
  };

  await client.query(
    `UPDATE import_batches
        SET imported_rows = $1, skipped_rows = $2, updated_at = now()
      WHERE id = $3`,
    [
      counts.transactions,
      counts.reviewRows + counts.invalidRows + counts.duplicateRows,
      importBatchId,
    ],
  );

  await client.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'import.commit', 'import_batch', $2, $3)`,
    [
      input.committedByUserId,
      importBatchId,
      JSON.stringify({ counts, checksum: input.checksumSha256 }),
    ],
  );

  return {
    alreadyCommitted: false,
    importedFileId,
    importBatchId,
    counts,
    reconciliation: staging.reconciliation,
    note: describeOutcome(counts, staging),
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create-or-match canonical people by normalized name.
 *
 * The unique index on normalized_name is what makes this safe under
 * concurrency: a losing INSERT falls through to the UPDATE and still returns
 * the winner's id, so two simultaneous imports converge on one record.
 */
async function upsertPeople(
  client: PgLikeClient,
  table: "individuals" | "employees",
  names: Map<string, string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [normalized, display] of names) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO ${table} (normalized_name, display_name)
       VALUES ($1, $2)
       ON CONFLICT (normalized_name) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [normalized, display],
    );
    out.set(normalized, rows[0].id);
  }
  return out;
}

function emptyCounts(input: CommitInput): CommitCounts {
  return {
    sourceRows: input.parsedRows.length,
    importRows: 0,
    transactions: 0,
    serviceSessions: 0,
    serviceAllocations: 0,
    individualsCreated: 0,
    employeesCreated: 0,
    rateExceptions: 0,
    warnings: 0,
    reviewRows: 0,
    invalidRows: 0,
    duplicateRows: 0,
  };
}

function describeOutcome(counts: CommitCounts, staging: StagingResult): string {
  const parts = [
    `${counts.transactions} transactions written from ${counts.sourceRows} source rows.`,
    `${counts.serviceSessions} service sessions and ${counts.serviceAllocations} individual allocations recorded.`,
  ];
  if (counts.reviewRows > 0) {
    parts.push(
      `${counts.reviewRows} rows need review and were preserved in import_rows without ` +
        `creating payroll transactions; they are excluded from budget utilization until resolved.`,
    );
  }
  if (counts.duplicateRows > 0) {
    parts.push(
      `${counts.duplicateRows} rows matched an already-committed transaction and were not re-imported.`,
    );
  }
  if (counts.invalidRows > 0) {
    parts.push(
      `${counts.invalidRows} rows could not be parsed and were preserved with their validation errors.`,
    );
  }
  parts.push(staging.reconciliation.note);
  return parts.join(" ");
}

/** Total imported agency gross actually written, for the reconciliation record. */
export function committedAgencyGross(staging: StagingResult): string {
  return toMoney(
    staging.rows
      .filter((r) => r.status === "valid")
      .reduce((sum, r) => sum.plus(dec(r.importedAmount)), dec(0)),
  );
}
