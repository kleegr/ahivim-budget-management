import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectLocalDocument, localDocumentTestRoot, readLocalDocument, writeLocalDocument } from "@/lib/documents/local-test-storage";

let root: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (root) { await rm(root, { recursive: true, force: true }); root = undefined; } });
async function isolated() {
  root = await mkdtemp(path.join(tmpdir(), "ahivim-document-test-"));
  vi.stubEnv("AHIVIM_TEST_DOCUMENT_STORAGE_DIR", root);
  vi.stubEnv("DATABASE_URL", "postgresql://test@127.0.0.1/ahivim_report");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", ""); vi.stubEnv("VERCEL", "");
  return root;
}

describe("isolated document storage", () => {
  it("is opt-in and refuses production database, deployed app, Blob token and traversal", async () => {
    vi.stubEnv("AHIVIM_TEST_DOCUMENT_STORAGE_DIR", ""); expect(localDocumentTestRoot()).toBeNull();
    await isolated(); expect(localDocumentTestRoot()).toBe(root);
    for (const database of ["postgresql://test@db.example/ahivim_test", "postgresql://test@127.0.0.1/production"]) {
      vi.stubEnv("DATABASE_URL", database); expect(() => localDocumentTestRoot()).toThrow(/isolated local/);
    }
    vi.stubEnv("DATABASE_URL", "postgresql://test@127.0.0.1/ahivim_report");
    vi.stubEnv("VERCEL", "1"); expect(() => localDocumentTestRoot()).toThrow(/deployed/);
    vi.stubEnv("VERCEL", ""); vi.stubEnv("BLOB_READ_WRITE_TOKEN", "production-token"); expect(() => localDocumentTestRoot()).toThrow(/Blob/);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", ""); await expect(writeLocalDocument("../escape.pdf", Buffer.from("%PDF-test"))).rejects.toThrow(/Invalid/);
  });
  it("preserves immutable originals, supports an identical retry, and reads exact bytes with ETags", async () => {
    await isolated();
    const pathname = "documents/10000000-0000-4000-8000-000000000001/uploads/20000000-0000-4000-8000-000000000001.pdf";
    const bytes = Buffer.from("%PDF-1.4\nsynthetic original\n%%EOF");
    await writeLocalDocument(pathname, bytes); await writeLocalDocument(pathname, bytes);
    await expect(writeLocalDocument(pathname, Buffer.from("%PDF-different"))).rejects.toThrow();
    const metadata = await inspectLocalDocument(pathname); expect(metadata.size).toBe(bytes.length);
    const read = await readLocalDocument(pathname); expect(Buffer.from(await new Response(read.stream).arrayBuffer())).toEqual(bytes);
    expect((await readLocalDocument(pathname, metadata.etag)).statusCode).toBe(304);
  });
});
