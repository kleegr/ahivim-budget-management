import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiDocumentEditorUser: vi.fn(),
  accessibleDocument: vi.fn(),
  createDocument: vi.fn(),
  createDocumentVersionUpload: vi.fn(),
  getDocumentVersionFile: vi.fn(),
}));

vi.mock("@/lib/auth/document-access", () => ({
  apiDocumentEditorUser: mocks.apiDocumentEditorUser,
}));
vi.mock("@/lib/document-route-helpers", () => ({
  accessibleDocument: mocks.accessibleDocument,
}));
vi.mock("@/lib/manage/documents", () => ({
  createDocument: mocks.createDocument,
  createDocumentVersionUpload: mocks.createDocumentVersionUpload,
}));
vi.mock("@/lib/data/documents", () => ({
  getDocumentVersionFile: mocks.getDocumentVersionFile,
  listDocuments: vi.fn(),
}));

import { POST as createDocument } from "@/app/api/documents/route";
import { POST as reserveVersion } from "@/app/api/documents/[id]/uploads/route";
import { GET as readVersionFile } from "@/app/api/documents/[id]/versions/[versionId]/file/route";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001";
const VERSION_ID = "00000000-0000-4000-8000-000000000002";
const access = {
  pool: { query: vi.fn() },
  user: { id: "00000000-0000-4000-8000-000000000003" },
};

function request(path: string, method: "GET" | "POST") {
  return new NextRequest(`http://localhost${path}`, method === "GET" ? undefined : {
    method,
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

describe("document storage configuration boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    mocks.apiDocumentEditorUser.mockResolvedValue(access);
    mocks.accessibleDocument.mockResolvedValue({ access, document: { id: DOCUMENT_ID } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not create an incomplete document record when private storage is absent", async () => {
    const response = await createDocument(request("/api/documents", "POST"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Private document storage is not configured. Ask an administrator to connect document storage.",
    });
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it("does not reserve an unusable edited-version upload", async () => {
    const response = await reserveVersion(
      request(`/api/documents/${DOCUMENT_ID}/uploads`, "POST"),
      { params: Promise.resolve({ id: DOCUMENT_ID }) },
    );

    expect(response.status).toBe(503);
    expect(mocks.createDocumentVersionUpload).not.toHaveBeenCalled();
  });

  it("returns an actionable service error before looking up a private blob", async () => {
    const response = await readVersionFile(
      request(`/api/documents/${DOCUMENT_ID}/versions/${VERSION_ID}/file`, "GET"),
      { params: Promise.resolve({ id: DOCUMENT_ID, versionId: VERSION_ID }) },
    );

    expect(response.status).toBe(503);
    expect(mocks.getDocumentVersionFile).not.toHaveBeenCalled();
  });
});
