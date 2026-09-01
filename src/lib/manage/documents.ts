import { randomUUID } from "node:crypto";
import {
  DOCUMENT_UUID,
  getDocument,
  getDocumentDraft,
  getDocumentVersion,
  type DocumentDraftRecord,
  type DocumentExportMode,
  type DocumentRecord,
  type DocumentVersionRecord,
} from "@/lib/data/documents";
import {
  documentUploadPathname,
  inspectPrivateDocumentBlob,
  maxPdfUploadBytes,
} from "@/lib/documents/document-storage";
import { parsePdfEditorManifest } from "@/lib/documents/pdf-editor-persistence";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { fail, ok, type Result } from "./errors";

const MAX_EDITOR_STATE_BYTES = 2 * 1024 * 1024;
const MAX_TITLE = 180;
const MAX_CATEGORY = 80;
const MAX_DESCRIPTION = 4_000;
const MAX_CHANGE_SUMMARY = 500;
const UPLOAD_MINUTES = 30;
const SHA256 = /^[0-9a-f]{64}$/;

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

export interface DocumentUploadReservation {
  intentId: string;
  pathname: string;
  handleUploadUrl: "/api/documents/uploads";
  maximumSizeInBytes: number;
  expiresAt: string;
}

export interface CreateDocumentInput {
  title: string;
  description?: string | null;
  category?: string | null;
  filename: string;
  byteSize: number;
}

export interface CreateDocumentResult {
  document: DocumentRecord;
  upload: DocumentUploadReservation;
}

export interface UploadedBlobMetadata {
  pathname: string;
  etag: string;
  contentType: string;
  size: number;
}

export interface DocumentUploadIntentRecord {
  id: string;
  documentId: string;
  purpose: "original" | "version";
  status: "pending" | "uploaded" | "finalized" | "expired";
  reservedPathname: string;
  filename: string;
  expectedByteSize: number;
  baseVersionId: string | null;
  createdByUserId: string;
  expiresAt: string;
  finalizedVersionId: string | null;
}

function cleanText(value: string | null | undefined, maximum: number): string | null {
  const clean = value?.trim() ?? "";
  return clean ? clean.slice(0, maximum) : null;
}

function validateTitle(value: string): string | null {
  const title = value?.trim() ?? "";
  return title && title.length <= MAX_TITLE ? title : null;
}

function validateCategory(value: string | null | undefined): string | null {
  const category = value?.trim() || "general";
  return category.length <= MAX_CATEGORY ? category : null;
}

export function safePdfFilename(value: string): string | null {
  const filename = value.replaceAll("\\", "/").split("/").pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  if (!filename || filename.length > 255 || !filename.toLowerCase().endsWith(".pdf")) return null;
  return filename;
}

function validateByteSize(value: number): number | null {
  return Number.isSafeInteger(value) && value > 0 && value <= maxPdfUploadBytes() ? value : null;
}

function normalizedJsonEditorState(value: unknown): Result<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("validation", "Editor state must be a JSON object.");
  }
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      return fail("validation", "Editor state must contain valid JSON values.");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_EDITOR_STATE_BYTES) {
      return fail("validation", "This editor state is too large to save.");
    }
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("validation", "Editor state must remain a JSON object.");
    }
    return ok(parsed as Record<string, unknown>);
  } catch {
    return fail("validation", "Editor state must contain valid JSON values.");
  }
}

function normalizedEditorState(
  value: unknown,
  editorSchemaVersion: number,
): Result<Record<string, unknown>> {
  const normalized = normalizedJsonEditorState(value);
  if (!normalized.ok) return normalized;
  const declaredSchemaVersion = normalized.data.schemaVersion;

  if (editorSchemaVersion === 1 && declaredSchemaVersion === undefined) {
    // Versions created before the structured PDF manifest remain readable and restorable.
    return normalized;
  }
  if ((editorSchemaVersion !== 1 && editorSchemaVersion !== 2)
    || declaredSchemaVersion !== editorSchemaVersion) {
    return fail("validation", "This PDF editor state version is not supported.");
  }
  const manifest = parsePdfEditorManifest(normalized.data);
  if (!manifest) {
    return fail("validation", "PDF editor state is incomplete or invalid. Reload the document and try again.");
  }
  return ok(manifest as unknown as Record<string, unknown>);
}

function uploadReservation(
  intentId: string,
  documentId: string,
  expiresAt: string,
): DocumentUploadReservation {
  return {
    intentId,
    pathname: documentUploadPathname(documentId, intentId),
    handleUploadUrl: "/api/documents/uploads",
    maximumSizeInBytes: maxPdfUploadBytes(),
    expiresAt,
  };
}

async function insertUploadIntent(
  db: Queryable,
  input: {
    documentId: string;
    purpose: "original" | "version";
    filename: string;
    byteSize: number;
    baseVersionId: string | null;
    actorId: string;
  },
): Promise<DocumentUploadReservation> {
  const intentId = randomUUID();
  const expiresAt = new Date(Date.now() + UPLOAD_MINUTES * 60_000).toISOString();
  const pathname = documentUploadPathname(input.documentId, intentId);
  await db.query(
    `INSERT INTO document_upload_intents
       (id, document_id, purpose, reserved_pathname, filename, expected_byte_size,
        base_version_id, created_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [intentId, input.documentId, input.purpose, pathname, input.filename, input.byteSize,
      input.baseVersionId, input.actorId, expiresAt],
  );
  return uploadReservation(intentId, input.documentId, expiresAt);
}

export async function createDocument(
  pool: PgLikePool,
  input: CreateDocumentInput,
  actorId: string,
): Promise<Result<CreateDocumentResult>> {
  const title = validateTitle(input.title);
  const category = validateCategory(input.category);
  const filename = safePdfFilename(input.filename);
  const byteSize = validateByteSize(input.byteSize);
  if (!title) return fail("validation", `Document title must be between 1 and ${MAX_TITLE} characters.`);
  if (!category) return fail("validation", `Document category may be at most ${MAX_CATEGORY} characters.`);
  if (!filename) return fail("validation", "Choose a PDF with a valid filename.");
  if (!byteSize) return fail("validation", `PDF size must be between 1 byte and ${maxPdfUploadBytes()} bytes.`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO documents
         (title, description, category, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $4)
       RETURNING id`,
      [title, cleanText(input.description, MAX_DESCRIPTION), category, actorId],
    );
    const id = rows[0]!.id;
    const upload = await insertUploadIntent(client, {
      documentId: id,
      purpose: "original",
      filename,
      byteSize,
      baseVersionId: null,
      actorId,
    });
    await recordChange(client, {
      actorId,
      action: "document_created",
      entityType: "document",
      entityId: id,
      next: { title, category, status: "uploading" },
      extra: { filename, byteSize },
    });
    await client.query("COMMIT");
    const document = await getDocument(pool, id);
    return ok({ document: document!, upload });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createDocumentVersionUpload(
  pool: PgLikePool,
  documentId: string,
  input: { filename: string; byteSize: number; baseVersionId: string },
  actorId: string,
): Promise<Result<DocumentUploadReservation>> {
  if (!DOCUMENT_UUID.test(documentId)) return fail("not_found", "That document was not found.");
  const filename = safePdfFilename(input.filename);
  const byteSize = validateByteSize(input.byteSize);
  if (!filename) return fail("validation", "Choose a PDF with a valid filename.");
  if (!byteSize) return fail("validation", `PDF size must be between 1 byte and ${maxPdfUploadBytes()} bytes.`);
  if (!DOCUMENT_UUID.test(input.baseVersionId)) return fail("validation", "Choose a valid base version.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string; current_version_id: string | null }>(
      `SELECT status, current_version_id FROM documents WHERE id = $1 FOR UPDATE`,
      [documentId],
    );
    const document = rows[0];
    if (!document) {
      await client.query("ROLLBACK");
      return fail("not_found", "That document was not found.");
    }
    if (document.status !== "active") {
      await client.query("ROLLBACK");
      return fail("immutable", "Restore or finish uploading this document before saving another version.");
    }
    if (document.current_version_id !== input.baseVersionId) {
      await client.query("ROLLBACK");
      return fail("conflict", "A newer document version already exists. Reload before saving.");
    }
    const upload = await insertUploadIntent(client, {
      documentId,
      purpose: "version",
      filename,
      byteSize,
      baseVersionId: input.baseVersionId,
      actorId,
    });
    await client.query("COMMIT");
    return ok(upload);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface IntentRow {
  id: string;
  document_id: string;
  purpose: "original" | "version";
  status: "pending" | "uploaded" | "finalized" | "expired";
  reserved_pathname: string;
  filename: string;
  expected_byte_size: string;
  base_version_id: string | null;
  created_by_user_id: string;
  expires_at: string;
  finalized_version_id: string | null;
}

const toIntent = (row: IntentRow): DocumentUploadIntentRecord => ({
  id: row.id,
  documentId: row.document_id,
  purpose: row.purpose,
  status: row.status,
  reservedPathname: row.reserved_pathname,
  filename: row.filename,
  expectedByteSize: Number(row.expected_byte_size),
  baseVersionId: row.base_version_id,
  createdByUserId: row.created_by_user_id,
  expiresAt: row.expires_at,
  finalizedVersionId: row.finalized_version_id,
});

export async function getDocumentUploadIntent(
  db: Queryable,
  intentId: string,
  actorId?: string,
): Promise<DocumentUploadIntentRecord | null> {
  if (!DOCUMENT_UUID.test(intentId)) return null;
  const params: unknown[] = [intentId];
  const actorClause = actorId ? (params.push(actorId), ` AND created_by_user_id = $2`) : "";
  const { rows } = await db.query<IntentRow>(
    `SELECT id, document_id, purpose, status, reserved_pathname, filename,
            expected_byte_size::text AS expected_byte_size, base_version_id,
            created_by_user_id, expires_at::text AS expires_at, finalized_version_id
       FROM document_upload_intents WHERE id = $1${actorClause}`,
    params,
  );
  return rows[0] ? toIntent(rows[0]) : null;
}

export function parseDocumentUploadTokenPayload(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { intentId?: unknown };
    return typeof parsed.intentId === "string" && DOCUMENT_UUID.test(parsed.intentId) ? parsed.intentId : null;
  } catch {
    return null;
  }
}

export async function authorizeDocumentUploadToken(
  pool: PgLikePool,
  input: { pathname: string; clientPayload: string | null; actorId: string },
): Promise<Result<{ intent: DocumentUploadIntentRecord; tokenPayload: string }>> {
  const intentId = parseDocumentUploadTokenPayload(input.clientPayload);
  if (!intentId) return fail("validation", "That upload reservation is invalid.");
  const intent = await getDocumentUploadIntent(pool, intentId, input.actorId);
  if (!intent || intent.status !== "pending" || new Date(intent.expiresAt).getTime() <= Date.now()) {
    return fail("not_found", "That upload reservation is no longer available.");
  }
  if (intent.reservedPathname !== input.pathname) {
    return fail("forbidden", "That upload path is not allowed.");
  }
  return ok({ intent, tokenPayload: JSON.stringify({ intentId: intent.id }) });
}

export async function completeDocumentUpload(
  pool: PgLikePool,
  intentId: string,
  blob: UploadedBlobMetadata,
): Promise<Result<DocumentUploadIntentRecord>> {
  const intent = await getDocumentUploadIntent(pool, intentId);
  if (!intent) return fail("not_found", "That upload reservation was not found.");
  if (intent.status === "finalized") return ok(intent);
  if (intent.status === "uploaded") {
    return blob.pathname === intent.reservedPathname ? ok(intent) : fail("conflict", "Upload metadata does not match.");
  }
  if (intent.status !== "pending" || new Date(intent.expiresAt).getTime() <= Date.now()) {
    await pool.query(`UPDATE document_upload_intents SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [intent.id]);
    return fail("conflict", "That upload reservation expired.");
  }
  if (blob.pathname !== intent.reservedPathname || blob.contentType !== "application/pdf") {
    return fail("validation", "The completed upload is not the reserved PDF.");
  }
  if (blob.size !== intent.expectedByteSize || blob.size > maxPdfUploadBytes() || blob.size <= 0) {
    return fail("validation", "The uploaded PDF size does not match the reservation.");
  }
  const { rowCount } = await pool.query(
    `UPDATE document_upload_intents
        SET status = 'uploaded', storage_pathname = $2, storage_etag = $3,
            uploaded_content_type = $4, uploaded_byte_size = $5, uploaded_at = now()
      WHERE id = $1 AND status = 'pending' AND expires_at > now()`,
    [intent.id, blob.pathname, blob.etag, blob.contentType, blob.size],
  );
  if (!rowCount) {
    const current = await getDocumentUploadIntent(pool, intent.id);
    if (current && (current.status === "uploaded" || current.status === "finalized")) return ok(current);
    return fail("conflict", "That upload reservation changed before it completed.");
  }
  return ok((await getDocumentUploadIntent(pool, intent.id))!);
}

/**
 * Vercel's completion webhook may arrive just after the browser upload resolves.
 * Verify the exact reserved private object so an immediate Save can finish
 * without weakening the signed upload-intent boundary.
 */
export async function reconcileDocumentUpload(
  pool: PgLikePool,
  documentId: string,
  intentId: string,
  actorId: string,
  inspectBlob: (pathname: string) => Promise<UploadedBlobMetadata> = inspectPrivateDocumentBlob,
): Promise<Result<DocumentUploadIntentRecord>> {
  const intent = await getDocumentUploadIntent(pool, intentId, actorId);
  if (!intent || intent.documentId !== documentId) {
    return fail("not_found", "That upload reservation was not found.");
  }
  if (intent.status === "uploaded" || intent.status === "finalized") return ok(intent);
  if (intent.status !== "pending" || new Date(intent.expiresAt).getTime() <= Date.now()) {
    return fail("conflict", "That upload reservation expired.");
  }
  try {
    return await completeDocumentUpload(pool, intent.id, await inspectBlob(intent.reservedPathname));
  } catch {
    return fail("conflict", "The PDF upload has not completed yet. Try saving again.");
  }
}

export interface FinalizeDocumentVersionInput {
  intentId: string;
  idempotencyKey: string;
  baseVersionId?: string | null;
  exportMode?: DocumentExportMode;
  editorSchemaVersion?: number;
  editorState?: Record<string, unknown>;
  pageCount?: number | null;
  changeSummary?: string | null;
  checksumSha256?: string | null;
}

export async function finalizeDocumentVersion(
  pool: PgLikePool,
  documentId: string,
  input: FinalizeDocumentVersionInput,
  actorId: string,
): Promise<Result<DocumentVersionRecord>> {
  if (!DOCUMENT_UUID.test(documentId)) return fail("not_found", "That document was not found.");
  if (!DOCUMENT_UUID.test(input.intentId) || !DOCUMENT_UUID.test(input.idempotencyKey)) {
    return fail("validation", "Upload intent and idempotency key must be valid IDs.");
  }
  const editorSchemaVersion = input.editorSchemaVersion ?? 1;
  if (!Number.isInteger(editorSchemaVersion) || editorSchemaVersion <= 0) {
    return fail("validation", "Editor schema version must be a positive integer.");
  }
  const editorState = normalizedEditorState(input.editorState ?? {}, editorSchemaVersion);
  if (!editorState.ok) return editorState;
  const pageCount = input.pageCount ?? null;
  if (pageCount !== null && (!Number.isInteger(pageCount) || pageCount <= 0 || pageCount > 100_000)) {
    return fail("validation", "Page count must be a positive integer.");
  }
  const checksum = input.checksumSha256?.toLowerCase() || null;
  if (checksum && !SHA256.test(checksum)) return fail("validation", "PDF checksum must be SHA-256.");
  const reconciled = await reconcileDocumentUpload(pool, documentId, input.intentId, actorId);
  if (!reconciled.ok) return reconciled;

  const client = await pool.connect();
  let versionId: string | null = null;
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string; upload_intent_id: string | null }>(
      `SELECT version.id, intent.id AS upload_intent_id
         FROM document_versions version
         LEFT JOIN document_upload_intents intent ON intent.finalized_version_id = version.id
        WHERE version.document_id = $1 AND version.idempotency_key = $2`,
      [documentId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].upload_intent_id !== input.intentId) {
        await client.query("ROLLBACK");
        return fail("conflict", "That save request ID was already used for another operation.");
      }
      versionId = existing.rows[0].id;
      await client.query("COMMIT");
      return ok((await getDocumentVersion(pool, documentId, versionId))!);
    }

    const locked = await client.query<{
      status: string;
      original_version_id: string | null;
      current_version_id: string | null;
      current_version_number: number | null;
    }>(
      `SELECT document.status, document.original_version_id, document.current_version_id,
              current_version.version_number AS current_version_number
         FROM documents document
         LEFT JOIN document_versions current_version ON current_version.id = document.current_version_id
        WHERE document.id = $1 FOR UPDATE OF document`,
      [documentId],
    );
    const document = locked.rows[0];
    if (!document) {
      await client.query("ROLLBACK");
      return fail("not_found", "That document was not found.");
    }
    if (document.status === "archived") {
      await client.query("ROLLBACK");
      return fail("immutable", "Restore this document before saving a version.");
    }

    const intentResult = await client.query<IntentRow & {
      storage_pathname: string | null;
      storage_etag: string | null;
      uploaded_content_type: string | null;
      uploaded_byte_size: string | null;
    }>(
      `SELECT id, document_id, purpose, status, reserved_pathname, filename,
              expected_byte_size::text AS expected_byte_size, base_version_id,
              created_by_user_id, expires_at::text AS expires_at, finalized_version_id,
              storage_pathname, storage_etag, uploaded_content_type,
              uploaded_byte_size::text AS uploaded_byte_size
         FROM document_upload_intents WHERE id = $1 FOR UPDATE`,
      [input.intentId],
    );
    const intent = intentResult.rows[0];
    if (!intent || intent.document_id !== documentId || intent.created_by_user_id !== actorId) {
      await client.query("ROLLBACK");
      return fail("not_found", "That upload reservation was not found.");
    }
    if (intent.status === "finalized" && intent.finalized_version_id) {
      versionId = intent.finalized_version_id;
      await client.query("COMMIT");
      return ok((await getDocumentVersion(pool, documentId, versionId))!);
    }
    if (intent.status !== "uploaded" || !intent.storage_pathname || !intent.storage_etag
        || intent.uploaded_content_type !== "application/pdf" || !intent.uploaded_byte_size) {
      await client.query("ROLLBACK");
      return fail("conflict", "The PDF upload has not completed yet.");
    }

    const original = document.current_version_id === null;
    if (original && intent.purpose !== "original") {
      await client.query("ROLLBACK");
      return fail("conflict", "Upload the original PDF before saving edits.");
    }
    if (!original) {
      if (document.status !== "active" || intent.purpose !== "version") {
        await client.query("ROLLBACK");
        return fail("conflict", "That upload does not match this document state.");
      }
      const baseVersionId = input.baseVersionId ?? intent.base_version_id;
      if (!baseVersionId || baseVersionId !== intent.base_version_id || baseVersionId !== document.current_version_id) {
        await client.query("ROLLBACK");
        return fail("conflict", "A newer document version already exists. Reload before saving.");
      }
    }

    const blobId = randomUUID();
    await client.query(
      `INSERT INTO document_blobs
         (id, document_id, purpose, storage_pathname, storage_etag, content_type,
          byte_size, filename, checksum_sha256, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'application/pdf', $6, $7, $8, $9)`,
      [blobId, documentId, original ? "original" : "edited", intent.storage_pathname,
        intent.storage_etag, Number(intent.uploaded_byte_size), intent.filename, checksum, actorId],
    );

    let sourceBlobId: string = blobId;
    if (!original) {
      const source = await client.query<{ source_blob_id: string }>(
        `SELECT source_blob_id FROM document_versions WHERE id = $1 AND document_id = $2`,
        [document.original_version_id, documentId],
      );
      if (!source.rows[0]) throw new Error("Document original version is missing.");
      sourceBlobId = source.rows[0].source_blob_id;
    }

    versionId = randomUUID();
    const versionNumber = original ? 1 : (document.current_version_number ?? 0) + 1;
    const exportMode: DocumentExportMode = original ? "source" : input.exportMode ?? "standard";
    if (!(["source", "standard", "secure"] as const).includes(exportMode)) {
      await client.query("ROLLBACK");
      return fail("validation", "Choose a valid PDF export mode.");
    }
    await client.query(
      `INSERT INTO document_versions
         (id, document_id, version_number, version_kind, parent_version_id,
          source_blob_id, output_blob_id, export_mode, editor_schema_version,
          editor_state, page_count, change_summary, idempotency_key, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [versionId, documentId, versionNumber, original ? "original" : "saved",
        document.current_version_id, sourceBlobId, blobId, exportMode, editorSchemaVersion,
        JSON.stringify(editorState.data), pageCount, cleanText(input.changeSummary, MAX_CHANGE_SUMMARY),
        input.idempotencyKey, actorId],
    );
    await client.query(
      `UPDATE documents
          SET status = 'active',
              original_version_id = COALESCE(original_version_id, $2),
              current_version_id = $2, updated_by_user_id = $3, updated_at = now(),
              archived_at = NULL, archived_by_user_id = NULL
        WHERE id = $1`,
      [documentId, versionId, actorId],
    );
    await client.query(
      `UPDATE document_upload_intents
          SET status = 'finalized', finalized_at = now(), finalized_version_id = $2
        WHERE id = $1`,
      [intent.id, versionId],
    );
    await client.query(`DELETE FROM document_drafts WHERE document_id = $1 AND user_id = $2`, [documentId, actorId]);
    await recordChange(client, {
      actorId,
      action: original ? "document_original_saved" : "document_version_saved",
      entityType: "document",
      entityId: documentId,
      previous: original ? undefined : { currentVersionId: document.current_version_id },
      next: { currentVersionId: versionId, versionNumber, exportMode },
      extra: { versionId, filename: intent.filename, byteSize: Number(intent.uploaded_byte_size) },
    });
    await client.query("COMMIT");
    return ok((await getDocumentVersion(pool, documentId, versionId))!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function saveDocumentDraft(
  pool: PgLikePool,
  documentId: string,
  input: {
    baseVersionId: string;
    expectedRevision: number | null;
    editorSchemaVersion?: number;
    editorState: Record<string, unknown>;
  },
  actorId: string,
): Promise<Result<DocumentDraftRecord>> {
  if (!DOCUMENT_UUID.test(documentId)) return fail("not_found", "That document was not found.");
  if (!DOCUMENT_UUID.test(input.baseVersionId)) return fail("validation", "Choose a valid base version.");
  const schemaVersion = input.editorSchemaVersion ?? 1;
  if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    return fail("validation", "Editor schema version must be a positive integer.");
  }
  const state = normalizedEditorState(input.editorState, schemaVersion);
  if (!state.ok) return state;
  if (input.expectedRevision !== null
      && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    return fail("validation", "Draft revision must be a positive integer or null.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const document = await client.query<{ status: string; current_version_id: string | null }>(
      `SELECT status, current_version_id FROM documents WHERE id = $1 FOR UPDATE`,
      [documentId],
    );
    if (!document.rows[0]) {
      await client.query("ROLLBACK");
      return fail("not_found", "That document was not found.");
    }
    if (document.rows[0].status !== "active" || document.rows[0].current_version_id !== input.baseVersionId) {
      await client.query("ROLLBACK");
      return fail("conflict", "A newer document version exists. Reload before autosaving.");
    }

    let rowCount = 0;
    if (input.expectedRevision === null) {
      const inserted = await client.query(
        `INSERT INTO document_drafts
           (document_id, user_id, base_version_id, revision, editor_schema_version, editor_state)
         VALUES ($1, $2, $3, 1, $4, $5)
         ON CONFLICT (document_id, user_id) DO NOTHING`,
        [documentId, actorId, input.baseVersionId, schemaVersion, JSON.stringify(state.data)],
      );
      rowCount = inserted.rowCount ?? 0;
    } else {
      const updated = await client.query(
        `UPDATE document_drafts
            SET revision = revision + 1, base_version_id = $3,
                editor_schema_version = $4, editor_state = $5, updated_at = now()
          WHERE document_id = $1 AND user_id = $2 AND revision = $6`,
        [documentId, actorId, input.baseVersionId, schemaVersion,
          JSON.stringify(state.data), input.expectedRevision],
      );
      rowCount = updated.rowCount ?? 0;
    }
    if (!rowCount) {
      await client.query("ROLLBACK");
      return fail("conflict", "A newer autosave already exists. Reload the draft before saving again.");
    }
    await client.query("COMMIT");
    return ok((await getDocumentDraft(pool, documentId, actorId))!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function discardDocumentDraft(
  pool: PgLikePool,
  documentId: string,
  actorId: string,
): Promise<Result<{ discarded: boolean }>> {
  if (!DOCUMENT_UUID.test(documentId)) return fail("not_found", "That document was not found.");
  if (!await getDocument(pool, documentId)) return fail("not_found", "That document was not found.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `DELETE FROM document_drafts WHERE document_id = $1 AND user_id = $2`,
      [documentId, actorId],
    );
    if (rowCount) {
      await recordChange(client, {
        actorId,
        action: "document_draft_discarded",
        entityType: "document",
        entityId: documentId,
      });
    }
    await client.query("COMMIT");
    return ok({ discarded: Boolean(rowCount) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateDocumentMetadata(
  pool: PgLikePool,
  documentId: string,
  input: { title?: string; description?: string | null; category?: string; status?: "active" | "archived" },
  actorId: string,
  reason?: string | null,
): Promise<Result<DocumentRecord>> {
  if (!DOCUMENT_UUID.test(documentId)) return fail("not_found", "That document was not found.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      title: string;
      description: string | null;
      category: string;
      status: "uploading" | "active" | "archived";
      current_version_id: string | null;
    }>(
      `SELECT title, description, category, status, current_version_id
         FROM documents WHERE id = $1 FOR UPDATE`,
      [documentId],
    );
    const before = locked.rows[0];
    if (!before) {
      await client.query("ROLLBACK");
      return fail("not_found", "That document was not found.");
    }
    const title = input.title === undefined ? before.title : validateTitle(input.title);
    const category = input.category === undefined ? before.category : validateCategory(input.category);
    if (!title || !category) {
      await client.query("ROLLBACK");
      return fail("validation", "Enter a valid document title and category.");
    }
    const description = input.description === undefined
      ? before.description
      : cleanText(input.description, MAX_DESCRIPTION);
    let status = input.status ?? before.status;
    if (status === "active" && !before.current_version_id) {
      await client.query("ROLLBACK");
      return fail("conflict", "Upload the original PDF before activating this document.");
    }
    if (before.status === "uploading" && status === "archived") {
      status = "archived";
    }
    const archived = status === "archived";
    await client.query(
      `UPDATE documents
          SET title = $2, description = $3, category = $4, status = $5,
              archived_at = CASE WHEN $5 = 'archived' THEN COALESCE(archived_at, now()) ELSE NULL END,
              archived_by_user_id = CASE WHEN $5 = 'archived' THEN COALESCE(archived_by_user_id, $6) ELSE NULL END,
              updated_by_user_id = $6, updated_at = now()
        WHERE id = $1`,
      [documentId, title, description, category, status, actorId],
    );
    if (archived) {
      await client.query(`DELETE FROM document_drafts WHERE document_id = $1`, [documentId]);
      await client.query(
        `UPDATE document_upload_intents SET status = 'expired'
          WHERE document_id = $1 AND status IN ('pending', 'uploaded')`,
        [documentId],
      );
    }
    await recordChange(client, {
      actorId,
      action: before.status !== status
        ? status === "archived" ? "document_archived" : "document_unarchived"
        : "document_metadata_updated",
      entityType: "document",
      entityId: documentId,
      previous: before,
      next: { title, description, category, status },
      reason,
    });
    await client.query("COMMIT");
    return ok((await getDocument(pool, documentId))!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function restoreDocumentVersion(
  pool: PgLikePool,
  documentId: string,
  versionId: string,
  input: { expectedCurrentVersionId: string; idempotencyKey: string; reason?: string | null },
  actorId: string,
): Promise<Result<DocumentVersionRecord>> {
  if (!DOCUMENT_UUID.test(documentId) || !DOCUMENT_UUID.test(versionId)) {
    return fail("not_found", "That document version was not found.");
  }
  if (!DOCUMENT_UUID.test(input.expectedCurrentVersionId) || !DOCUMENT_UUID.test(input.idempotencyKey)) {
    return fail("validation", "Current version and idempotency key must be valid IDs.");
  }
  const client = await pool.connect();
  let restoredId: string | null = null;
  try {
    await client.query("BEGIN");
    const existing = await client.query<{
      id: string;
      version_kind: DocumentVersionRecord["versionKind"];
      restored_from_version_id: string | null;
    }>(
      `SELECT id, version_kind, restored_from_version_id
         FROM document_versions WHERE document_id = $1 AND idempotency_key = $2`,
      [documentId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].version_kind !== "restored"
          || existing.rows[0].restored_from_version_id !== versionId) {
        await client.query("ROLLBACK");
        return fail("conflict", "That restore request ID was already used for another operation.");
      }
      restoredId = existing.rows[0].id;
      await client.query("COMMIT");
      return ok((await getDocumentVersion(pool, documentId, restoredId))!);
    }
    const document = await client.query<{ status: string; current_version_id: string; version_number: number }>(
      `SELECT document.status, document.current_version_id, current.version_number
         FROM documents document
         JOIN document_versions current ON current.id = document.current_version_id
        WHERE document.id = $1 FOR UPDATE OF document`,
      [documentId],
    );
    const current = document.rows[0];
    if (!current || current.status !== "active") {
      await client.query("ROLLBACK");
      return fail("not_found", "That active document was not found.");
    }
    if (current.current_version_id !== input.expectedCurrentVersionId) {
      await client.query("ROLLBACK");
      return fail("conflict", "A newer document version already exists. Reload before restoring.");
    }
    const target = await client.query<{
      source_blob_id: string;
      output_blob_id: string;
      export_mode: DocumentExportMode;
      editor_schema_version: number;
      editor_state: Record<string, unknown>;
      page_count: number | null;
      version_number: number;
    }>(
      `SELECT source_blob_id, output_blob_id, export_mode, editor_schema_version,
              editor_state, page_count, version_number
         FROM document_versions WHERE document_id = $1 AND id = $2`,
      [documentId, versionId],
    );
    if (!target.rows[0]) {
      await client.query("ROLLBACK");
      return fail("not_found", "That document version was not found.");
    }
    restoredId = randomUUID();
    const versionNumber = current.version_number + 1;
    const changeSummary = cleanText(input.reason, MAX_CHANGE_SUMMARY)
      ?? `Restored version ${target.rows[0].version_number}`;
    await client.query(
      `INSERT INTO document_versions
         (id, document_id, version_number, version_kind, parent_version_id,
          restored_from_version_id, source_blob_id, output_blob_id, export_mode,
           editor_schema_version, editor_state, page_count, change_summary,
           idempotency_key, created_by_user_id)
       VALUES ($1, $2, $3, 'restored', $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13, $14)`,
      [restoredId, documentId, versionNumber, current.current_version_id, versionId,
        target.rows[0].source_blob_id, target.rows[0].output_blob_id, target.rows[0].export_mode,
        target.rows[0].editor_schema_version, JSON.stringify(target.rows[0].editor_state),
        target.rows[0].page_count, changeSummary, input.idempotencyKey, actorId],
    );
    await client.query(
      `UPDATE documents SET current_version_id = $2, updated_by_user_id = $3, updated_at = now()
        WHERE id = $1`,
      [documentId, restoredId, actorId],
    );
    await client.query(
      `DELETE FROM document_drafts WHERE document_id = $1 AND user_id = $2`,
      [documentId, actorId],
    );
    await recordChange(client, {
      actorId,
      action: "document_version_restored",
      entityType: "document",
      entityId: documentId,
      previous: { currentVersionId: current.current_version_id },
      next: { currentVersionId: restoredId, versionNumber },
      reason: input.reason,
      extra: { restoredFromVersionId: versionId },
    });
    await client.query("COMMIT");
    return ok((await getDocumentVersion(pool, documentId, restoredId))!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
