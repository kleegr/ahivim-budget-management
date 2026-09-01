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
    mocks.accessibleDocument.mockResolvedValue({
      access: { pool, user: { id: "00000000-0000-4000-8000-000000000003" } },
      document: { id: DOCUMENT_ID },
    });
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

  it("serves the source representation for editable reopen without changing normal downloads", async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/file?source=1`),
      { params: Promise.resolve({ id: DOCUMENT_ID, versionId: VERSION_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.getDocumentVersionFile).toHaveBeenCalledWith(pool, DOCUMENT_ID, VERSION_ID, "source");
    expect(mocks.writeAudit).toHaveBeenCalledWith(pool, expect.objectContaining({
      metadata: { versionId: VERSION_ID, representation: "source" },
    }));
  });
});
