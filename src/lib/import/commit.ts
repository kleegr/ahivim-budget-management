import { dec, toMoney, toHours } from "@/lib/money";
import type { ParsedAhivimRow } from "@/lib/excel/parse-workbook";
import type { StagingResult, StagedRow, RateConfig } from "./stage";
import { evaluateRateException } from "@/lib/business/rate-exceptions";
import { normalizePersonName } from "@/lib/business/name-matching";
import { backfillPaymentAttribution } from "@/lib/manage/payment-attribution";

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
 * resolves the mapping and re-imports. See docs/import-architecture.md.
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
  const importRowIds = new Map<number, string>();

  for (const parsed of parsedRows) {
    const staged = stagedByRow.get(parsed.sourceRowNumber);
    const status = staged?.status ?? "invalid";
    const iKey = parsed.parsed ? normalizePersonName(parsed.parsed.individual) : "";
    const eKey = parsed.parsed ? normalizePersonName(parsed.parsed.employee) : "";

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO import_rows
         (import_batch_id, sheet_name, source_row_number, raw_values, status,
          validation_errors, resolved_individual_id, resolved_employee_id,
          resolved_program_id, transaction_fingerprint)
       VALUES ($1, 'Ahivim', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        importBatchId,
        parsed.sourceRowNumber,
        JSON.stringify({ raw: parsed.raw, formulas: parsed.formulas }),
        status === "valid" ? "imported" : status,
        parsed.errors.length ? JSON.stringify(parsed.errors) : null,
        status === "valid" ? (individuals.get(iKey) ?? null) : null,
        status === "valid" ? (employees.get(eKey) ?? null) : null,
        staged?.programCode ? (programIds.get(staged.programCode) ?? null) : null,
        staged?.fingerprint ?? null,
      ],
    );
    importRowIds.set(parsed.sourceRowNumber, rows[0].id);
  }

  /* ---- 6. payroll_transactions: VALID rows only --------------------------- */
  const transactionIds = new Map<number, string>();

  for (const staged of staging.rows) {
    if (staged.status !== "valid") continue;
    const parsed = parsedByRow.get(staged.sourceRowNumber);
    if (!parsed?.parsed) continue;
    const p = parsed.parsed;
    const rate = staged.programCode ? input.ratesByProgram[staged.programCode] : undefined;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO payroll_transactions
         (import_batch_id, import_row_id, source_file_id, source_row_number,
          pay_to_raw, check_number, check_date, period_begin, period_end,
          individual_id, employee_id, program_id,
          individual_raw, employee_raw, program_raw,
          imported_hours, imported_rate, imported_amount, total_net_pay,
          spreadsheet_internal_amount, calculated_internal_amount,
          internal_rate_applied, agency_rate_applied, internal_amount_mismatch,
          transaction_fingerprint, duplicate_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       RETURNING id`,
      [
        importBatchId,
        importRowIds.get(staged.sourceRowNumber) ?? null,
        importedFileId,
        staged.sourceRowNumber,
        p.payTo || null,
        p.checkNumber || null,
        p.checkDate || null,
        p.periodBegin || null,
        p.periodEnd || null,
        individuals.get(normalizePersonName(p.individual)) ?? null,
        employees.get(normalizePersonName(p.employee)) ?? null,
        staged.programCode ? (programIds.get(staged.programCode) ?? null) : null,
        p.individual,
        p.employee || null,
        p.programDescription,
        toHours(p.hours),
        toMoney(p.rate),
        toMoney(p.amount),
        p.totalNetPay ? toMoney(p.totalNetPay) : null,
        staged.spreadsheetInternalAmount,
        staged.calculatedInternalAmount,
        rate?.internalRate ?? null,
        rate?.agencyRate ?? null,
        staged.internalAmountMismatch,
        staged.fingerprint,
        staged.duplicateStatus,
      ],
    );
    transactionIds.set(staged.sourceRowNumber, rows[0].id);
  }

  /* ---- 7. service sessions and equal allocations -------------------------- */
  //
  // A session stores the employee's PHYSICAL hours once. Each allocation gets
  // those same full hours and an equal share of the money. Buckets staged
  // `needs_review` produce no allocations and are recorded as sessions awaiting
  // a decision, so the money is never quietly split on a guess.
  let sessionCount = 0;
  let allocationCount = 0;

  for (const group of staging.groups) {
    const memberRows = group.sourceRowRefs
      .map((n) => ({ n, staged: stagedByRow.get(n), parsed: parsedByRow.get(n)?.parsed }))
      .filter((m) => m.staged?.status === "valid" && m.parsed);
    if (memberRows.length === 0) continue;

    const lead = memberRows[0];
    const { rows: sessionRows } = await client.query<{ id: string }>(
      `INSERT INTO service_sessions
         (import_batch_id, employee_id, program_id, check_number, period_begin, period_end,
          physical_hours, group_size, combined_rate, combined_amount, base_individual_rate,
          group_detection_status, detection_rule, detection_signature, confidence,
          validation_result, warning_reason, source_row_refs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        importBatchId,
        employees.get(normalizePersonName(lead.parsed!.employee)) ?? null,
        lead.staged!.programCode ? (programIds.get(lead.staged!.programCode) ?? null) : null,
        lead.parsed!.checkNumber || null,
        lead.parsed!.periodBegin || null,
        lead.parsed!.periodEnd || null,
        group.physicalHours,
        group.groupSize,
        group.combinedRate,
        group.combinedAmount,
        group.baseIndividualRate,
        group.status,
        group.detectionRule,
        group.signature,
        group.confidence,
        JSON.stringify(group.validation),
        group.warningReason,
        JSON.stringify(group.sourceRowRefs),
      ],
    );
    const sessionId = sessionRows[0].id;
    sessionCount++;

    const isGroup = group.groupSize > 1 && group.status === "detected";
    for (const member of memberRows) {
      const txId = transactionIds.get(member.n) ?? null;
      if (txId) {
        await client.query(
          `UPDATE payroll_transactions
              SET service_session_id = $1, is_group_service = $2, updated_at = now()
            WHERE id = $3`,
          [sessionId, isGroup, txId],
        );
      }

      const allocation = group.allocations.find((a) => a.importRowId === `row-${member.n}`);
      if (!allocation) continue; // needs_review buckets produce no allocations

      const individualId = individuals.get(normalizePersonName(member.parsed!.individual));
      if (!individualId) continue;

      await client.query(
        `INSERT INTO service_allocations
           (service_session_id, individual_id, payroll_transaction_id,
            allocation_hours, allocated_rate, allocated_amount, rounding_adjustment)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (service_session_id, individual_id) DO NOTHING`,
        [
          sessionId,
          individualId,
          txId,
          allocation.allocationHours,
          allocation.allocatedRate,
          allocation.allocatedAmount,
          allocation.roundingAdjustment,
        ],
      );
      allocationCount++;
    }
  }

  /* ---- 8. warnings, rate exceptions --------------------------------------- */
  let rateExceptionCount = 0;

  for (const warning of staging.warnings) {
    const rowId =
      warning.sourceRowNumber !== null
        ? (importRowIds.get(warning.sourceRowNumber) ?? null)
        : null;
    const staged =
      warning.sourceRowNumber !== null ? stagedByRow.get(warning.sourceRowNumber) : undefined;
    const parsed =
      warning.sourceRowNumber !== null
        ? parsedByRow.get(warning.sourceRowNumber)?.parsed
        : undefined;

    await client.query(
      `INSERT INTO import_warnings
         (import_batch_id, import_row_id, individual_id, category, severity, message, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        importBatchId,
        rowId,
        parsed ? (individuals.get(normalizePersonName(parsed.individual)) ?? null) : null,
        warning.category,
        warning.severity,
        warning.message,
        warning.details ? JSON.stringify(warning.details) : null,
      ],
    );

    if (warning.category !== "rate_exception" || !parsed || !staged?.programCode) continue;

    // Recompute the variance from the same inputs staging used, so the stored
    // exception carries the actual imported and expected rates rather than a
    // re-derived guess.
    const config = input.ratesByProgram[staged.programCode];
    if (!config) continue;
    const evaluated = evaluateRateException({
      importedRate: parsed.rate,
      expectedRate: config.internalRate,
    });

    await client.query(
      `INSERT INTO rate_exceptions
         (import_batch_id, payroll_transaction_id, individual_id, program_id,
          imported_rate, expected_rate, variance_amount, variance_percent, direction, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        importBatchId,
        transactionIds.get(staged.sourceRowNumber) ?? null,
        individuals.get(normalizePersonName(parsed.individual)) ?? null,
        programIds.get(staged.programCode) ?? null,
        evaluated.importedRate,
        evaluated.expectedRate,
        evaluated.varianceAmount,
        evaluated.variancePercent,
        evaluated.direction === "match" ? "higher" : evaluated.direction,
        evaluated.summary,
      ],
    );
    rateExceptionCount++;
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
