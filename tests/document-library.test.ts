import { afterEach, describe, expect, it, vi } from "vitest";
import {
  documentUploadPathname,
  maxPdfUploadBytes,
} from "@/lib/documents/document-storage";
import type { PgLikePool } from "@/lib/import/commit";
import {
  authorizeDocumentUploadToken,
  completeDocumentUpload,
  parseDocumentUploadTokenPayload,
  reconcileDocumentUpload,
  safePdfFilename,
} from "@/lib/manage/documents";

const INTENT = "00000000-0000-4000-8000-000000000001";
const DOCUMENT = "00000000-0000-4000-8000-000000000002";
const ACTOR = "00000000-0000-4000-8000-000000000003";
const PATHNAME = documentUploadPathname(DOCUMENT, INTENT);

function intentRow(status: "pending" | "uploaded" = "pending") {
  return {
    id: INTENT,
    document_id: DOCUMENT,
    purpose: "original" as const,
    status,
    reserved_pathname: PATHNAME,
    filename: "source.pdf",
    expected_byte_size: "2048",
    base_version_id: null,
    created_by_user_id: ACTOR,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    finalized_version_id: null,
  };
}

afterEach(() => {
  delete process.env.MAX_PDF_UPLOAD_BYTES;
});

describe("document persistence boundary", () => {
  it("uses opaque storage paths and sanitizes uploaded PDF names", () => {
    expect(PATHNAME).toBe(`documents/${DOCUMENT}/uploads/${INTENT}.pdf`);
    expect(safePdfFilename("C:\\fakepath\\report.pdf")).toBe("report.pdf");
    expect(safePdfFilename("../report.PDF")).toBe("report.PDF");
    expect(safePdfFilename("report.exe")).toBeNull();
  });

  it("bounds configured PDF upload sizes", () => {
    process.env.MAX_PDF_UPLOAD_BYTES = "4096";
    expect(maxPdfUploadBytes()).toBe(4096);
    process.env.MAX_PDF_UPLOAD_BYTES = "not-a-number";
    expect(maxPdfUploadBytes()).toBe(100 * 1024 * 1024);
    process.env.MAX_PDF_UPLOAD_BYTES = String(900 * 1024 * 1024);
    expect(maxPdfUploadBytes()).toBe(500 * 1024 * 1024);
  });

  it("accepts only the actor-bound intent and exact reserved pathname", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [intentRow()] }));
    const pool = { query } as unknown as PgLikePool;
    const payload = JSON.stringify({ intentId: INTENT });

    const allowed = await authorizeDocumentUploadToken(pool, {
      pathname: PATHNAME,
      clientPayload: payload,
      actorId: ACTOR,
    });
    expect(allowed).toMatchObject({
      ok: true,
      data: { intent: { id: INTENT, expectedByteSize: 2048 } },
    });
    expect(query.mock.calls[0]?.[1]).toEqual([INTENT, ACTOR]);

    const denied = await authorizeDocumentUploadToken(pool, {
      pathname: `${PATHNAME}.wrong`,
      clientPayload: payload,
      actorId: ACTOR,
    });
    expect(denied).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("rejects untrusted or malformed token payloads", () => {
    expect(parseDocumentUploadTokenPayload(null)).toBeNull();
    expect(parseDocumentUploadTokenPayload("not-json")).toBeNull();
    expect(parseDocumentUploadTokenPayload(JSON.stringify({ intentId: "../file.pdf" }))).toBeNull();
    expect(parseDocumentUploadTokenPayload(JSON.stringify({ intentId: INTENT }))).toBe(INTENT);
  });

  it("completes a matching callback once and records provider metadata", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes("UPDATE document_upload_intents")) return { rows: [], rowCount: 1 };
      const completed = query.mock.calls.some(([statement]) => String(statement).includes("UPDATE document_upload_intents"));
      return { rows: [intentRow(completed ? "uploaded" : "pending")], rowCount: 1 };
    });
    const pool = { query } as unknown as PgLikePool;
    const result = await completeDocumentUpload(pool, INTENT, {
      pathname: PATHNAME,
      etag: '"etag"',
      contentType: "application/pdf",
      size: 2048,
    });

    expect(result).toMatchObject({ ok: true, data: { status: "uploaded" } });
    const update = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE document_upload_intents"));
    expect(update?.[1]).toEqual([INTENT, PATHNAME, '"etag"', "application/pdf", 2048]);
  });

  it("rejects a callback whose path, type, or size differs from the reservation", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [intentRow()] })) } as unknown as PgLikePool;
    await expect(completeDocumentUpload(pool, INTENT, {
      pathname: "documents/other.pdf",
      etag: "etag",
      contentType: "application/pdf",
      size: 2048,
    })).resolves.toMatchObject({ ok: false, code: "validation" });
    await expect(completeDocumentUpload(pool, INTENT, {
      pathname: PATHNAME,
      etag: "etag",
      contentType: "text/plain",
      size: 2048,
    })).resolves.toMatchObject({ ok: false, code: "validation" });
    await expect(completeDocumentUpload(pool, INTENT, {
      pathname: PATHNAME,
      etag: "etag",
      contentType: "application/pdf",
      size: 2049,
    })).resolves.toMatchObject({ ok: false, code: "validation" });
  });

  it("reconciles the reserved blob when the provider callback is delayed", async () => {
    let status: "pending" | "uploaded" = "pending";
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes("UPDATE document_upload_intents")) {
        status = "uploaded";
        return { rows: [], rowCount: 1 };
      }
      return { rows: [intentRow(status)], rowCount: 1 };
    });
    const inspect = vi.fn(async () => ({
      pathname: PATHNAME,
      etag: '"reconciled"',
      contentType: "application/pdf",
      size: 2048,
    }));

    await expect(reconcileDocumentUpload(
      { query } as unknown as PgLikePool,
      DOCUMENT,
      INTENT,
      ACTOR,
      inspect,
    )).resolves.toMatchObject({ ok: true, data: { status: "uploaded" } });
    expect(inspect).toHaveBeenCalledWith(PATHNAME);
  });
});
