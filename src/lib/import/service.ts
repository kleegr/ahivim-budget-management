import { createHash } from "node:crypto";
import type { PgLikePool } from "./commit";
import { commitStagedImport, type CommitResult } from "./commit";
import {
  buildPendingPayload,
  slimSheetSummary,
  stageAgainstDatabase,
  validatePendingPayload,
  type PendingPayload,
} from "./pipeline";
import { parseWorkbook } from "@/lib/excel/parse-workbook";
import { currentRatesByProgram } from "@/lib/data/queries";
import { scanMatches } from "@/lib/manage/individual-merge";
import type { StagingResult } from "./stage";

/**
 * The import workflow, independent of HTTP.
 *
 *   upload -> parse -> stage -> validate -> review -> commit -> report
 *
 * Staging never touches an official business record: the uploaded workbook is
 * parsed into a pending payload stored on imported_files.sheet_summary, and
 * nothing enters payroll_transactions until commit() runs, inside a single
 * database transaction.
 */

export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function maxUploadBytes(): number {
  const configured = Number(process.env.MAX_UPLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type UploadOutcome =
  | { ok: true; fileId: string; checksum: string; staging: StagingResult; payload: PendingPayload }
  | {
      ok: false;
      reason: "too_large" | "wrong_type" | "duplicate_file" | "already_staged" | "unparseable";
      message: string;
      fileId?: string;
    };

export interface UploadInput {
  filename: string;
  bytes: Buffer;
  uploadedByUserId: string | null;
}

/**
 * Parse and stage an uploaded workbook.
 *
 * The SHA-256 of the bytes is the file-level identity. A file whose checksum
 * already belongs to a committed batch is refused outright, which is what stops
 * the same workbook being imported twice by accident.
 */
export async function uploadAndStage(
  pool: PgLikePool,
  input: UploadInput,
): Promise<UploadOutcome> {
  if (!/\.xlsx$/i.test(input.filename)) {
    return {
      ok: false,
      reason: "wrong_type",
      message: "Only .xlsx workbooks are accepted. Save the file as .xlsx and upload it again.",
    };
  }
  if (input.bytes.byteLength === 0) {
    return { ok: false, reason: "unparseable", message: "That file is empty." };
  }
  if (input.bytes.byteLength > maxUploadBytes()) {
    return {
      ok: false,
      reason: "too_large",
      message: `That file is larger than the ${Math.round(maxUploadBytes() / 1024 / 1024)} MB upload limit.`,
    };
  }

  const checksum = sha256(input.bytes);

  const { rows: existing } = await pool.query<{
    id: string;
    status: string | null;
  }>(
    `SELECT f.id, b.status
       FROM imported_files f
       LEFT JOIN import_batches b ON b.imported_file_id = f.id
      WHERE f.checksum_sha256 = $1
      ORDER BY (b.status = 'committed') DESC
      LIMIT 1`,
    [checksum],
  );

  if (existing[0]?.status === "committed") {
    return {
      ok: false,
      reason: "duplicate_file",
      fileId: existing[0].id,
      message:
        "This exact workbook has already been imported and committed. Nothing was staged. " +
        "Open the existing import to see what it wrote.",
    };
  }
  if (existing[0]) {
    return {
      ok: false,
      reason: "already_staged",
      fileId: existing[0].id,
      message:
        "This exact workbook is already staged and waiting for review. Open it rather than " +
        "uploading a second copy.",
    };
  }

  let parse;
  try {
    parse = await parseWorkbook(input.bytes);
  } catch (error) {
    return {
      ok: false,
      reason: "unparseable",
      message: `That workbook could not be read: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  if (parse.ahivimRows.length === 0) {
    return {
      ok: false,
      reason: "unparseable",
      message:
        "No transaction rows were found. The Ahivim sheet is missing, empty, or its columns " +
        "could not be matched. No data was staged.",
    };
  }

  const payload = buildPendingPayload({
    parse,
    originalFilename: input.filename,
    byteSize: input.bytes.byteLength,
    checksumSha256: checksum,
    uploadedByUserId: input.uploadedByUserId,
  });

  const staging = await stageAgainstDatabase(pool, payload.parsedRows, payload.controlTotals);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO imported_files
       (original_filename, byte_size, checksum_sha256, uploaded_by_user_id,
        template_detected, sheet_summary)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      payload.originalFilename,
      payload.byteSize,
      checksum,
      input.uploadedByUserId,
      payload.templateDetected,
      JSON.stringify(payload),
    ],
  );

  return { ok: true, fileId: rows[0]!.id, checksum, staging, payload };
}

export interface StagedFile {
  id: string;
  filename: string;
  byteSize: number;
  checksum: string;
  uploadedAt: string;
  templateDetected: string | null;
  payload: PendingPayload | null;
  committedBatchId: string | null;
  batchStatus: string | null;
}

export async function loadFile(pool: PgLikePool, fileId: string): Promise<StagedFile | null> {
  const { rows } = await pool.query<{
    id: string;
    original_filename: string;
    byte_size: number;
    checksum_sha256: string;
    uploaded_at: string;
    template_detected: string | null;
    sheet_summary: unknown;
    batch_id: string | null;
    batch_status: string | null;
  }>(
    `SELECT f.id, f.original_filename, f.byte_size, f.checksum_sha256,
            f.uploaded_at::text AS uploaded_at, f.template_detected, f.sheet_summary,
            b.id AS batch_id, b.status AS batch_status
       FROM imported_files f
       LEFT JOIN import_batches b ON b.imported_file_id = f.id
      WHERE f.id = $1
      LIMIT 1`,
    [fileId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    filename: row.original_filename,
    byteSize: Number(row.byte_size),
    checksum: row.checksum_sha256,
    uploadedAt: row.uploaded_at,
    templateDetected: row.template_detected,
    payload: validatePendingPayload(row.sheet_summary),
    committedBatchId: row.batch_status === "committed" ? row.batch_id : null,
    batchStatus: row.batch_status,
  };
}

/** Re-run staging for a pending file so the review screen reflects the DB now. */
export async function restage(
  pool: PgLikePool,
  payload: PendingPayload,
): Promise<StagingResult> {
  return stageAgainstDatabase(pool, payload.parsedRows, payload.controlTotals);
}

export type CommitOutcome =
  | { ok: true; result: CommitResult }
  | { ok: false; reason: "not_found" | "already_committed" | "no_payload"; message: string };

/**
 * Commit a staged file.
 *
 * Staging is re-run first, deliberately: rates or canonical people may have
 * changed since upload, and the numbers written must reflect the database as it
 * is at commit time. commitStagedImport does the whole write in one
 * transaction and rolls the entire thing back on any failure.
 */
export async function commit(
  pool: PgLikePool,
  fileId: string,
  committedByUserId: string | null,
): Promise<CommitOutcome> {
  const file = await loadFile(pool, fileId);
  if (!file) return { ok: false, reason: "not_found", message: "That import no longer exists." };
  if (file.committedBatchId) {
    return {
      ok: false,
      reason: "already_committed",
      message: "This import has already been committed. Nothing was written a second time.",
    };
  }
  if (!file.payload) {
    return {
      ok: false,
      reason: "no_payload",
      message:
        "The staged payload for this file is missing or unreadable, so it cannot be committed. " +
        "Upload the workbook again.",
    };
  }

  const staging = await restage(pool, file.payload);
  const ratesByProgram = await currentRatesByProgram(pool);

  const result = await commitStagedImport(pool, {
    checksumSha256: file.payload.checksumSha256,
    originalFilename: file.payload.originalFilename,
    byteSize: file.payload.byteSize,
    templateDetected: file.payload.templateDetected,
    sheetSummary: slimSheetSummary(file.payload),
    parsedRows: file.payload.parsedRows,
    staging,
    ratesByProgram,
    committedByUserId,
  });

  // The bulky pending payload is no longer needed once the rows are stored;
  // every source row survives in import_rows.raw_values.
  await pool.query(`UPDATE imported_files SET sheet_summary = $2, updated_at = now() WHERE id = $1`, [
    result.importedFileId,
    JSON.stringify(slimSheetSummary(file.payload)),
  ]);

  // Self-heal duplicates. A person spelled one way in the Calculations tab and
  // another in the ledger (Markowitz/Markovitz, Fleishman/Fleischman) is now
  // committed under both spellings; the scanner auto-merges the confident
  // single-letter typos and queues anything less certain on the Matches screen,
  // so budgets, financials and the ledger converge on one record. Non-fatal: the
  // rows are already committed if this step fails.
  try {
    await scanMatches(pool, committedByUserId);
  } catch {
    /* the ledger is committed; any remaining duplicates can be merged manually */
  }

  return { ok: true, result };
}

export type DiscardOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" | "already_committed"; message: string };

/** Discard a staged file. Refuses once anything has been committed from it. */
export async function discard(pool: PgLikePool, fileId: string): Promise<DiscardOutcome> {
  const file = await loadFile(pool, fileId);
  if (!file) return { ok: false, reason: "not_found", message: "That import no longer exists." };
  if (file.committedBatchId) {
    return {
      ok: false,
      reason: "already_committed",
      message:
        "This import has been committed and cannot be discarded. Committed records are kept so " +
        "the ledger stays traceable to its source rows.",
    };
  }
  await pool.query(`DELETE FROM imported_files WHERE id = $1`, [fileId]);
  return { ok: true };
}
