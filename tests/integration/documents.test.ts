import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  completeDocumentUpload,
  createDocument,
  createDocumentVersionUpload,
  finalizeDocumentVersion,
  restoreDocumentVersion,
  saveDocumentDraft,
  updateDocumentMetadata,
} from "@/lib/manage/documents";
import type { PgLikePool } from "@/lib/import/commit";
import {
  closeTestPool,
  hasTestDatabase,
  resetSchema,
  testPool,
  truncateBusinessTables,
} from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

function unwrap<T>(value: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!value.ok) throw new Error(`${value.code}: ${value.message}`);
  return value.data;
}

async function completedUpload(intentId: string, pathname: string, size: number) {
  return unwrap(await completeDocumentUpload(pool, intentId, {
    pathname,
    etag: `"etag-${intentId}"`,
    contentType: "application/pdf",
    size,
  }));
}

async function originalDocument() {
  const created = unwrap(await createDocument(pool, {
    title: "Service authorization",
    description: "Original retained",
    category: "authorization",
    filename: "authorization.pdf",
    byteSize: 2048,
  }, ACTOR));
  await completedUpload(created.upload.intentId, created.upload.pathname, 2048);
  const original = unwrap(await finalizeDocumentVersion(pool, created.document.id, {
    intentId: created.upload.intentId,
    idempotencyKey: randomUUID(),
    exportMode: "source",
    editorSchemaVersion: 1,
    editorState: {},
    pageCount: 2,
    checksumSha256: "a".repeat(64),
  }, ACTOR));
  return { created, original };
}

suite("document persistence (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);

  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, can_edit_documents)
       VALUES ($1, 'documents@example.test', 'Document Editor', 'x', 'viewer', true)`,
      [ACTOR],
    );
  });

  afterAll(closeTestPool);

  it("preserves the original, autosaves optimistically, appends saves, and restores by appending", async () => {
    const { created, original } = await originalDocument();
    expect(original).toMatchObject({ versionNumber: 1, versionKind: "original", exportMode: "source" });

    const firstDraft = unwrap(await saveDocumentDraft(pool, created.document.id, {
      baseVersionId: original.id,
      expectedRevision: null,
      editorSchemaVersion: 1,
      editorState: { overlays: [{ id: "one", kind: "text" }] },
    }, ACTOR));
    expect(firstDraft.revision).toBe(1);
    const secondDraft = unwrap(await saveDocumentDraft(pool, created.document.id, {
      baseVersionId: original.id,
      expectedRevision: 1,
      editorSchemaVersion: 1,
      editorState: { overlays: [{ id: "two", kind: "text" }] },
    }, ACTOR));
    expect(secondDraft.revision).toBe(2);
    await expect(saveDocumentDraft(pool, created.document.id, {
      baseVersionId: original.id,
      expectedRevision: 1,
      editorState: {},
    }, ACTOR)).resolves.toMatchObject({ ok: false, code: "conflict" });

    const upload = unwrap(await createDocumentVersionUpload(pool, created.document.id, {
      filename: "authorization-edited.pdf",
      byteSize: 3072,
      baseVersionId: original.id,
    }, ACTOR));
    await completedUpload(upload.intentId, upload.pathname, 3072);
    const saved = unwrap(await finalizeDocumentVersion(pool, created.document.id, {
      intentId: upload.intentId,
      idempotencyKey: randomUUID(),
      baseVersionId: original.id,
      exportMode: "standard",
      editorSchemaVersion: 1,
      editorState: { overlays: [{ id: "two", kind: "text" }] },
      pageCount: 2,
      changeSummary: "Corrected authorization date",
      checksumSha256: "b".repeat(64),
    }, ACTOR));
    expect(saved).toMatchObject({ versionNumber: 2, versionKind: "saved", parentVersionId: original.id });

    const restored = unwrap(await restoreDocumentVersion(pool, created.document.id, original.id, {
      expectedCurrentVersionId: saved.id,
      idempotencyKey: randomUUID(),
      reason: "Return to signed original",
    }, ACTOR));
    expect(restored).toMatchObject({
      versionNumber: 3,
      versionKind: "restored",
      parentVersionId: saved.id,
      restoredFromVersionId: original.id,
      checksumSha256: "a".repeat(64),
    });

    const state = await pool.query<{
      original_version_id: string;
      current_version_id: string;
      version_count: string;
      blob_count: string;
      draft_count: string;
    }>(
      `SELECT document.original_version_id, document.current_version_id,
              (SELECT count(*)::text FROM document_versions WHERE document_id = document.id) AS version_count,
              (SELECT count(*)::text FROM document_blobs WHERE document_id = document.id) AS blob_count,
              (SELECT count(*)::text FROM document_drafts WHERE document_id = document.id) AS draft_count
         FROM documents document WHERE document.id = $1`,
      [created.document.id],
    );
    expect(state.rows[0]).toEqual({
      original_version_id: original.id,
      current_version_id: restored.id,
      version_count: "3",
      blob_count: "2",
      draft_count: "0",
    });

    await expect(pool.query(`UPDATE document_versions SET change_summary = 'rewrite' WHERE id = $1`, [original.id]))
      .rejects.toThrow(/immutable/i);
    await expect(pool.query(`DELETE FROM document_blobs WHERE document_id = $1`, [created.document.id]))
      .rejects.toThrow(/immutable/i);

    const actions = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at, ctid`,
      [created.document.id],
    );
    expect(actions.rows.map((row) => row.action)).toEqual([
      "document_created",
      "document_original_saved",
      "document_version_saved",
      "document_version_restored",
    ]);
  });

  it("rolls a version and its blob back when the audit entry cannot be written", async () => {
    const { created, original } = await originalDocument();
    const upload = unwrap(await createDocumentVersionUpload(pool, created.document.id, {
      filename: "retry.pdf",
      byteSize: 4096,
      baseVersionId: original.id,
    }, ACTOR));
    await completedUpload(upload.intentId, upload.pathname, 4096);
    await pool.query(
      `ALTER TABLE audit_logs ADD CONSTRAINT test_reject_document_save
       CHECK (action <> 'document_version_saved')`,
    );
    const input = {
      intentId: upload.intentId,
      idempotencyKey: randomUUID(),
      baseVersionId: original.id,
      exportMode: "standard" as const,
      editorState: { overlays: [] },
    };
    try {
      await expect(finalizeDocumentVersion(pool, created.document.id, input, ACTOR)).rejects.toThrow();
    } finally {
      await pool.query(`ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS test_reject_document_save`);
    }

    const rolledBack = await pool.query<{ versions: string; blobs: string; intent_status: string; current_version_id: string }>(
      `SELECT
         (SELECT count(*)::text FROM document_versions WHERE document_id = $1) AS versions,
         (SELECT count(*)::text FROM document_blobs WHERE document_id = $1) AS blobs,
         (SELECT status FROM document_upload_intents WHERE id = $2) AS intent_status,
         (SELECT current_version_id FROM documents WHERE id = $1) AS current_version_id`,
      [created.document.id, upload.intentId],
    );
    expect(rolledBack.rows[0]).toEqual({
      versions: "1",
      blobs: "1",
      intent_status: "uploaded",
      current_version_id: original.id,
    });

    const retried = unwrap(await finalizeDocumentVersion(pool, created.document.id, input, ACTOR));
    expect(retried.versionNumber).toBe(2);
  });

  it("archives without deleting history and requires an explicit unarchive before further edits", async () => {
    const { created, original } = await originalDocument();
    const archived = unwrap(await updateDocumentMetadata(pool, created.document.id, { status: "archived" }, ACTOR, "Closed case"));
    expect(archived).toMatchObject({ status: "archived" });
    await expect(createDocumentVersionUpload(pool, created.document.id, {
      filename: "blocked.pdf",
      byteSize: 1024,
      baseVersionId: original.id,
    }, ACTOR)).resolves.toMatchObject({ ok: false, code: "immutable" });

    const active = unwrap(await updateDocumentMetadata(pool, created.document.id, { status: "active" }, ACTOR));
    expect(active).toMatchObject({ status: "active", currentVersionId: original.id });
    const counts = await pool.query<{ documents: string; versions: string; blobs: string }>(
      `SELECT (SELECT count(*)::text FROM documents) AS documents,
              (SELECT count(*)::text FROM document_versions) AS versions,
              (SELECT count(*)::text FROM document_blobs) AS blobs`,
    );
    expect(counts.rows[0]).toEqual({ documents: "1", versions: "1", blobs: "1" });
  });
});
