import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  accessibleDocument: vi.fn(),
  getDocumentVersionFile: vi.fn(),
  readPrivateDocumentBlob: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/lib/document-route-helpers", () => ({ accessibleDocument: mocks.accessibleDocument }));
vi.mock("@/lib/data/documents", () => ({ getDocumentVersionFile: mocks.getDocumentVersionFile }));
vi.mock("@/lib/documents/document-storage", () => ({
  hasDocumentStorage: () => true,
  readPrivateDocumentBlob: mocks.readPrivateDocumentBlob,
}));
vi.mock("@/lib/auth/users", () => ({ writeAudit: mocks.writeAudit }));

import { GET } from "@/app/api/documents/[id]/versions/[versionId]/file/route";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001";
const VERSION_ID = "00000000-0000-4000-8000-000000000002";
const pool = { query: vi.fn() };

describe("document version file route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accessibleDocument.mockImplementation(async (_id: string, mode: "view" | "edit") => (
      mode === "edit"
        ? { error: new Response("Not found", { status: 404 }) }
        : {
            access: { pool, user: { id: "00000000-0000-4000-8000-000000000003" } },
            document: { id: DOCUMENT_ID },
          }
    ));
    mocks.getDocumentVersionFile.mockResolvedValue({
      pathname: "documents/source.pdf",
      filename: "source.pdf",
      byteSize: 4,
    });
    mocks.readPrivateDocumentBlob.mockResolvedValue({
      statusCode: 200,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([37, 80, 68, 70]));
          controller.close();
        },
      }),
      blob: { etag: "source-etag" },
    });
  });

  it("serves the normal output to a read-only document viewer", async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/file`),
      { params: Promise.resolve({ id: DOCUMENT_ID, versionId: VERSION_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.accessibleDocument).toHaveBeenCalledWith(DOCUMENT_ID, "view");
    expect(mocks.getDocumentVersionFile).toHaveBeenCalledWith(pool, DOCUMENT_ID, VERSION_ID, "output");
  });

  it("does not expose the retained source representation to a read-only viewer", async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/file?source=1`),
      { params: Promise.resolve({ id: DOCUMENT_ID, versionId: VERSION_ID }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.accessibleDocument).toHaveBeenCalledWith(DOCUMENT_ID, "edit");
    expect(mocks.getDocumentVersionFile).not.toHaveBeenCalled();
    expect(mocks.readPrivateDocumentBlob).not.toHaveBeenCalled();
  });

  it("serves the source representation to an editor for editable reopen", async () => {
    mocks.accessibleDocument.mockResolvedValueOnce({
      access: { pool, user: { id: "00000000-0000-4000-8000-000000000003" } },
      document: { id: DOCUMENT_ID },
    });
    const response = await GET(
      new NextRequest(`http://localhost/api/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/file?source=1`),
      { params: Promise.resolve({ id: DOCUMENT_ID, versionId: VERSION_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.accessibleDocument).toHaveBeenCalledWith(DOCUMENT_ID, "edit");
    expect(mocks.getDocumentVersionFile).toHaveBeenCalledWith(pool, DOCUMENT_ID, VERSION_ID, "source");
    expect(mocks.writeAudit).toHaveBeenCalledWith(pool, expect.objectContaining({
      metadata: { versionId: VERSION_ID, representation: "source" },
    }));
  });
});
