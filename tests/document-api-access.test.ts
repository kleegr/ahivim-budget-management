import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiDocumentViewerUser: vi.fn(),
  apiDocumentEditorUser: vi.fn(),
  accessibleDocument: vi.fn(),
}));

vi.mock("@/lib/auth/document-access", () => ({
  apiDocumentViewerUser: mocks.apiDocumentViewerUser,
  apiDocumentEditorUser: mocks.apiDocumentEditorUser,
}));
vi.mock("@/lib/document-route-helpers", () => ({ accessibleDocument: mocks.accessibleDocument }));

import { GET as listDocuments, POST as createDocument } from "@/app/api/documents/route";
import { GET as getDocument, PATCH as updateDocument } from "@/app/api/documents/[id]/route";
import { POST as reserveVersion } from "@/app/api/documents/[id]/uploads/route";
import { DELETE as discardDraft, GET as getDraft, PUT as saveDraft } from "@/app/api/documents/[id]/draft/route";
import { GET as listVersions, POST as saveVersion } from "@/app/api/documents/[id]/versions/route";
import { GET as getVersionFile } from "@/app/api/documents/[id]/versions/[versionId]/file/route";
import { POST as restoreVersion } from "@/app/api/documents/[id]/versions/[versionId]/restore/route";

const ID = "00000000-0000-4000-8000-000000000001";
const VERSION = "00000000-0000-4000-8000-000000000002";
const params = { params: Promise.resolve({ id: ID }) };
const versionParams = { params: Promise.resolve({ id: ID, versionId: VERSION }) };

function request(path: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" = "GET") {
  return new NextRequest(`http://localhost${path}`, method === "GET" ? undefined : {
    method,
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

describe("document API authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiDocumentViewerUser.mockResolvedValue(null);
    mocks.apiDocumentEditorUser.mockResolvedValue(null);
    mocks.accessibleDocument.mockResolvedValue({
      error: Response.json({ ok: false, error: "That document was not found." }, { status: 404 }),
    });
  });

  it("denies collection access without the document capability", async () => {
    expect((await listDocuments(request("/api/documents"))).status).toBe(403);
    expect((await createDocument(request("/api/documents", "POST"))).status).toBe(403);
  });

  it("allows a read-only user to list documents but not create one", async () => {
    mocks.apiDocumentViewerUser.mockResolvedValue({
      user: { id: "viewer-1" },
      scope: { canViewDocuments: true, canEditDocuments: false },
      pool: { query: vi.fn(async () => ({ rows: [] })) },
    });

    expect((await listDocuments(request("/api/documents"))).status).toBe(200);
    expect((await createDocument(request("/api/documents", "POST"))).status).toBe(403);
  });

  const cases: Array<[string, () => Promise<Response>]> = [
    ["read", () => getDocument(request(`/api/documents/${ID}`), params)],
    ["update/archive", () => updateDocument(request(`/api/documents/${ID}`, "PATCH"), params)],
    ["reserve upload", () => reserveVersion(request(`/api/documents/${ID}/uploads`, "POST"), params)],
    ["read draft", () => getDraft(request(`/api/documents/${ID}/draft`), params)],
    ["save draft", () => saveDraft(request(`/api/documents/${ID}/draft`, "PUT"), params)],
    ["discard draft", () => discardDraft(request(`/api/documents/${ID}/draft`, "DELETE"), params)],
    ["list versions", () => listVersions(request(`/api/documents/${ID}/versions`), params)],
    ["save version", () => saveVersion(request(`/api/documents/${ID}/versions`, "POST"), params)],
    ["stream file", () => getVersionFile(request(`/api/documents/${ID}/versions/${VERSION}/file`), versionParams)],
    ["restore version", () => restoreVersion(request(`/api/documents/${ID}/versions/${VERSION}/restore`, "POST"), versionParams)],
  ];

  it.each(cases)("returns 404 for an inaccessible document ID: %s", async (_label, invoke) => {
    const response = await invoke();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "That document was not found." });
  });

  it("uses view access for reads and edit access for every mutation", async () => {
    const readCalls = [
      () => getDocument(request(`/api/documents/${ID}`), params),
      () => getDraft(request(`/api/documents/${ID}/draft`), params),
      () => listVersions(request(`/api/documents/${ID}/versions`), params),
    ];
    for (const invoke of readCalls) {
      mocks.accessibleDocument.mockClear();
      await invoke();
      expect(mocks.accessibleDocument).toHaveBeenCalledWith(ID);
    }
    mocks.accessibleDocument.mockClear();
    await getVersionFile(request(`/api/documents/${ID}/versions/${VERSION}/file`), versionParams);
    expect(mocks.accessibleDocument).toHaveBeenCalledWith(ID, "view");

    const writeCalls = [
      () => updateDocument(request(`/api/documents/${ID}`, "PATCH"), params),
      () => reserveVersion(request(`/api/documents/${ID}/uploads`, "POST"), params),
      () => saveDraft(request(`/api/documents/${ID}/draft`, "PUT"), params),
      () => discardDraft(request(`/api/documents/${ID}/draft`, "DELETE"), params),
      () => saveVersion(request(`/api/documents/${ID}/versions`, "POST"), params),
      () => restoreVersion(request(`/api/documents/${ID}/versions/${VERSION}/restore`, "POST"), versionParams),
    ];
    for (const invoke of writeCalls) {
      mocks.accessibleDocument.mockClear();
      await invoke();
      expect(mocks.accessibleDocument).toHaveBeenCalledWith(ID, "edit");
    }
  });
});
