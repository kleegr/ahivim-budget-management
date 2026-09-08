import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const sdk = vi.hoisted(() => ({ head: vi.fn(), get: vi.fn(), put: vi.fn(), del: vi.fn(), handleUpload: vi.fn() }));
vi.mock("@vercel/blob", () => sdk);
vi.mock("@vercel/blob/client", () => ({ handleUpload: sdk.handleUpload }));

import { deletePrivateDocumentBlob, hasDocumentStorage, inspectPrivateDocumentBlob, readPrivateDocumentBlob, writePrivateDocumentPublication } from "@/lib/documents/document-storage";
import { POST as uploadCallback } from "@/app/api/documents/uploads/route";

const PATHNAME = "documents/00000000-0000-4000-8000-000000000001/publications/00000000-0000-4000-8000-000000000002.pdf";
const CONFIGURED_TOKEN = "synthetic-explicit-private-store-token";

describe("document storage credential consistency", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", ` ${CONFIGURED_TOKEN} `);
    vi.stubEnv("BLOB_STORE_ID", "store_other_environment");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "synthetic-platform-oidc-token");
    sdk.head.mockResolvedValue({ pathname: PATHNAME, etag: "etag", contentType: "application/pdf", size: 3 });
    sdk.get.mockResolvedValue(null);
    sdk.handleUpload.mockResolvedValue({ type: "blob.upload-completed", response: "ok" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("pins metadata, reads, publication writes, and deletes to the configured upload token", async () => {
    await inspectPrivateDocumentBlob(PATHNAME);
    await readPrivateDocumentBlob(PATHNAME, "previous-etag");
    await writePrivateDocumentPublication(PATHNAME, new Uint8Array([1, 2, 3]));
    await deletePrivateDocumentBlob(PATHNAME);
    expect(sdk.head).toHaveBeenCalledWith(PATHNAME, { token: CONFIGURED_TOKEN });
    expect(sdk.get).toHaveBeenCalledWith(PATHNAME, { token: CONFIGURED_TOKEN, access: "private", ifNoneMatch: "previous-etag" });
    expect(sdk.put).toHaveBeenCalledWith(PATHNAME, expect.any(Buffer), { token: CONFIGURED_TOKEN, access: "private", contentType: "application/pdf", addRandomSuffix: false, allowOverwrite: false });
    expect(sdk.del).toHaveBeenCalledWith(PATHNAME, { token: CONFIGURED_TOKEN });
  });

  it("passes the same credential to the SDK that verifies upload callbacks and signs client tokens", async () => {
    await uploadCallback(new NextRequest("http://localhost/api/documents/uploads", { method: "POST", body: JSON.stringify({ type: "blob.upload-completed", payload: {} }) }));
    expect(sdk.handleUpload).toHaveBeenCalledWith(expect.objectContaining({ token: CONFIGURED_TOKEN, onUploadCompleted: expect.any(Function), onBeforeGenerateToken: expect.any(Function) }));
  });

  it("does not silently select another store through inherited platform credentials", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", " ");
    expect(hasDocumentStorage()).toBe(false);
    for (const operation of [
      () => inspectPrivateDocumentBlob(PATHNAME), () => readPrivateDocumentBlob(PATHNAME),
      () => writePrivateDocumentPublication(PATHNAME, new Uint8Array([1])), () => deletePrivateDocumentBlob(PATHNAME),
    ]) await expect(operation()).rejects.toThrow("Private document storage is not configured.");
    expect(sdk.head).not.toHaveBeenCalled(); expect(sdk.get).not.toHaveBeenCalled();
    expect(sdk.put).not.toHaveBeenCalled(); expect(sdk.del).not.toHaveBeenCalled();
  });
});
