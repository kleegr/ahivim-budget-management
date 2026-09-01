import { describe, expect, it, vi } from "vitest";
import { createImageOverlay, createTextOverlay } from "@/lib/documents/pdf-editor";
import {
  MAX_PDF_EDITOR_ASSET_BYTES,
  MAX_PDF_EDITOR_ASSET_TOTAL_BYTES,
  createPdfEditorManifest,
  decodePdfEditorAssets,
  parsePdfEditorManifest,
  pdfEditorAssetCapacityError,
} from "@/lib/documents/pdf-editor-persistence";
import type { PgLikePool } from "@/lib/import/commit";
import { finalizeDocumentVersion, saveDocumentDraft } from "@/lib/manage/documents";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000010";
const BASE_VERSION_ID = "00000000-0000-4000-8000-000000000011";
const ACTOR_ID = "00000000-0000-4000-8000-000000000012";

function jsonManifest(value: ReturnType<typeof createPdfEditorManifest>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function draftPool() {
  let persistedState: Record<string, unknown> = {};
  const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT status, current_version_id")) {
      return { rows: [{ status: "active", current_version_id: BASE_VERSION_ID }] };
    }
    if (sql.includes("INSERT INTO document_drafts")) {
      persistedState = JSON.parse(String(params?.[4])) as Record<string, unknown>;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const poolQuery = vi.fn(async () => ({
    rows: [{
      document_id: DOCUMENT_ID,
      user_id: ACTOR_ID,
      base_version_id: BASE_VERSION_ID,
      revision: "1",
      editor_schema_version: 1,
      editor_state: persistedState,
      updated_at: "2026-09-01T00:00:00.000Z",
    }],
  }));
  const pool = {
    query: poolQuery,
    connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
  } as unknown as PgLikePool;
  return { pool, clientQuery, persistedState: () => persistedState };
}

describe("PDF editor persistence", () => {
  it("round-trips editable state and only its referenced image and imported font assets", () => {
    const text = createTextOverlay(2, {
      text: "Still editable",
      fontId: "custom-font",
    });
    const image = createImageOverlay(1, "signature-image", 2);
    const manifest = createPdfEditorManifest({
      overlays: [image, text],
      pageOrder: [2, 1],
      pageRotations: { 1: 90 },
      formValues: { approval: "yes" },
      exportMode: "secure",
      fonts: [
        {
          id: "custom-font",
          name: "Custom Sans",
          bytes: new Uint8Array([1, 2, 3, 4]),
          mimeType: "font/otf",
          source: "imported",
        },
        {
          id: "unused-font",
          name: "Unused",
          bytes: new Uint8Array([5]),
          mimeType: "font/ttf",
          source: "imported",
        },
      ],
      images: [
        {
          id: "signature-image",
          name: "signature.png",
          bytes: new Uint8Array([137, 80, 78, 71]),
          mimeType: "image/png",
        },
        {
          id: "unused-image",
          name: "unused.jpg",
          bytes: new Uint8Array([255, 216]),
          mimeType: "image/jpeg",
        },
      ],
    });

    const parsed = parsePdfEditorManifest(JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      schemaVersion: 2,
      overlays: [image, text],
      pageOrder: [2, 1],
      pageRotations: { 1: 90 },
      formValues: { approval: "yes" },
      exportMode: "secure",
    });
    expect(parsed?.assets.fonts.map((asset) => asset.id)).toEqual(["custom-font"]);
    expect(parsed?.assets.images.map((asset) => asset.id)).toEqual(["signature-image"]);

    const decoded = decodePdfEditorAssets(parsed!);
    expect(Array.from(decoded.fonts[0]!.bytes)).toEqual([1, 2, 3, 4]);
    expect(decoded.fonts[0]).toMatchObject({ name: "Custom Sans", mimeType: "font/otf" });
    expect(Array.from(decoded.images[0]!.bytes)).toEqual([137, 80, 78, 71]);
    expect(decoded.images[0]).toMatchObject({ name: "signature.png", mimeType: "image/png" });
  });

  it("upgrades legacy asset-free manifests when reopening existing versions", () => {
    const parsed = parsePdfEditorManifest({
      schemaVersion: 1,
      overlays: [],
      pageOrder: [1],
      pageRotations: {},
      formValues: {},
      exportMode: "standard",
    });

    expect(parsed).toEqual({
      schemaVersion: 2,
      overlays: [],
      pageOrder: [1],
      pageRotations: {},
      formValues: {},
      exportMode: "standard",
      assets: { fonts: [], images: [] },
    });
  });

  it("enforces per-asset and aggregate limits before an unpersistable edit is accepted", () => {
    expect(pdfEditorAssetCapacityError(0, MAX_PDF_EDITOR_ASSET_BYTES + 1, "image"))
      .toContain("too large");
    expect(pdfEditorAssetCapacityError(
      MAX_PDF_EDITOR_ASSET_TOTAL_BYTES - 10,
      11,
      "font",
    )).toContain("1.2 MB");
    expect(parsePdfEditorManifest({
      schemaVersion: 2,
      overlays: [],
      pageOrder: [1],
      pageRotations: {},
      formValues: {},
      exportMode: "standard",
      assets: {
        fonts: [],
        images: [{ id: "bad", name: "bad.png", mimeType: "image/png", data: "not-base64" }],
      },
    })).toBeNull();
  });

  it("rejects malformed overlay, page, rotation, form, and asset references", () => {
    const text = createTextOverlay(1);
    const valid = jsonManifest(createPdfEditorManifest({
      overlays: [text],
      pageOrder: [1],
      pageRotations: {},
      formValues: {},
      exportMode: "standard",
    }));
    const malformed = [
      { ...valid, pageOrder: [] },
      { ...valid, pageRotations: { 2: 90 } },
      { ...valid, pageRotations: { 1: 45 } },
      { ...valid, formValues: { approval: [true] } },
      { ...valid, overlays: [{ ...text, width: 2 }] },
      { ...valid, overlays: [text, { ...text }] },
      { ...valid, overlays: [{ ...text, page: 2 }] },
      { ...valid, overlays: [{ ...text, color: "red" }] },
      {
        ...valid,
        overlays: [createImageOverlay(1, "missing-image")],
      },
      {
        ...valid,
        overlays: [{ ...text, fontId: "custom-missing" }],
      },
      {
        ...valid,
        assets: {
          fonts: [],
          images: [{ id: "orphan", name: "orphan.png", mimeType: "image/png", data: "AQ==" }],
        },
      },
      {
        ...valid,
        overlays: [{ ...text, fontId: "custom-duplicate" }],
        assets: {
          fonts: [
            { id: "custom-duplicate", name: "one", mimeType: "font/ttf", data: "AQ==" },
            { id: "custom-duplicate", name: "two", mimeType: "font/otf", data: "Ag==" },
          ],
          images: [],
        },
      },
    ];

    for (const candidate of malformed) {
      expect(parsePdfEditorManifest(candidate as Record<string, unknown>)).toBeNull();
    }
  });

  it("sanitizes accepted manifests and preserves intentional duplicate source pages", () => {
    const text = { ...createTextOverlay(2), ignored: "do not persist" };
    const parsed = parsePdfEditorManifest({
      ...jsonManifest(createPdfEditorManifest({
        overlays: [text],
        pageOrder: [1, 1],
        pageRotations: { 2: 90 },
        formValues: { approval: ["yes"] },
        exportMode: "secure",
      })),
      ignored: "do not persist",
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.pageOrder).toEqual([1, 1]);
    expect(parsed).not.toHaveProperty("ignored");
    expect(parsed?.overlays[0]).not.toHaveProperty("ignored");
  });

  it("keeps safe legacy manifests readable but refuses legacy edits whose assets were never saved", () => {
    const standardText = createTextOverlay(1);
    expect(parsePdfEditorManifest({
      schemaVersion: 1,
      overlays: [standardText],
      pageOrder: [1],
      pageRotations: {},
      formValues: {},
      exportMode: "standard",
    })).not.toBeNull();
    expect(parsePdfEditorManifest({
      schemaVersion: 1,
      overlays: [createImageOverlay(1, "legacy-image")],
      pageOrder: [1],
      pageRotations: {},
      formValues: {},
      exportMode: "standard",
    })).toBeNull();
    expect(parsePdfEditorManifest({
      schemaVersion: 1,
      overlays: [{ ...standardText, fontId: "custom-legacy" }],
      pageOrder: [1],
      pageRotations: {},
      formValues: {},
      exportMode: "standard",
    })).toBeNull();
  });

  it("rejects invalid schema-2 saves server-side before touching document storage", async () => {
    const pool = {
      query: vi.fn(),
      connect: vi.fn(),
    } as unknown as PgLikePool;
    const invalidState = {
      schemaVersion: 2,
      overlays: [{ id: "partial", kind: "text" }],
      pageOrder: [1],
      pageRotations: {},
      formValues: {},
      exportMode: "standard",
      assets: { fonts: [], images: [] },
    };

    await expect(saveDocumentDraft(pool, DOCUMENT_ID, {
      baseVersionId: BASE_VERSION_ID,
      expectedRevision: null,
      editorSchemaVersion: 2,
      editorState: invalidState,
    }, ACTOR_ID)).resolves.toMatchObject({ ok: false, code: "validation" });
    await expect(finalizeDocumentVersion(pool, DOCUMENT_ID, {
      intentId: "00000000-0000-4000-8000-000000000013",
      idempotencyKey: "00000000-0000-4000-8000-000000000014",
      editorSchemaVersion: 2,
      editorState: invalidState,
    }, ACTOR_ID)).resolves.toMatchObject({ ok: false, code: "validation" });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("continues accepting unversioned schema-1 draft state from the original editor", async () => {
    const { pool, persistedState } = draftPool();
    const legacyState = { overlays: [{ id: "legacy", kind: "text" }], selection: null };

    await expect(saveDocumentDraft(pool, DOCUMENT_ID, {
      baseVersionId: BASE_VERSION_ID,
      expectedRevision: null,
      editorSchemaVersion: 1,
      editorState: legacyState,
    }, ACTOR_ID)).resolves.toMatchObject({ ok: true });
    expect(persistedState()).toEqual(legacyState);
  });
});
