import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PDFDocument, PDFName } from "pdf-lib";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import type { AuthenticatedUser } from "@/lib/auth/session";
import { ACCOUNT_PRESETS } from "@/lib/auth/account-presets";
import { CLASS_BILLING_ACCESS, PORTAL_ONLY_ACCESS } from "@/lib/auth/access-presets";
import { createUserWithAccessQuery, type UserAccessConfig } from "@/lib/auth/users";
import { completeDocumentUpload, createDocument, createDocumentVersionUpload, finalizeDocumentVersion } from "@/lib/manage/documents";
import type { DocumentAccessContext } from "@/lib/auth/document-policy";
import { createClassBudget, createClassInvoiceDraft } from "@/lib/manage/class-invoices";
import { MIGRATIONS } from "@/lib/db/migrations.generated";
import { prepareOriginalPdfUpload } from "@/lib/documents/pdf-document-upload";
import { createPdfEditorManifest, parsePdfEditorManifest } from "@/lib/documents/pdf-editor-persistence";
import { createTextOverlay } from "@/lib/documents/pdf-editor";

const state = vi.hoisted(() => ({ pool: null as unknown as PgLikePool, user: null as AuthenticatedUser | null, files: new Map<string, Blob>() }));
vi.mock("@/lib/db", () => ({ getPool: () => state.pool }));
vi.mock("@/lib/auth/session", async (original) => ({ ...await original<object>(), apiUser: async () => state.user }));
vi.mock("@/lib/documents/document-storage", async (original) => ({
  ...await original<object>(), hasDocumentStorage: () => true,
  readPrivateDocumentBlob: async (pathname: string) => ({ statusCode: 200, blob: { etag: pathname }, stream: (state.files.get(pathname) ?? new Blob(["MISSING"])).stream() }),
  readDocumentBytesForPublication: async (pathname: string) => new Uint8Array(await state.files.get(pathname)!.arrayBuffer()),
  writePrivateDocumentPublication: async (pathname: string, bytes: Uint8Array) => { state.files.set(pathname, new Blob([Uint8Array.from(bytes).buffer])); },
  deletePrivateDocumentBlob: async (pathname: string) => { state.files.delete(pathname); },
}));

import { GET as listing, POST as upload } from "@/app/api/documents/route";
import { GET as detail, PATCH as metadata } from "@/app/api/documents/[id]/route";
import { GET as drafts, PUT as saveDraft } from "@/app/api/documents/[id]/draft/route";
import { GET as history, POST as finalizeUpload } from "@/app/api/documents/[id]/versions/route";
import { POST as reserveVersion } from "@/app/api/documents/[id]/uploads/route";
import { GET as file } from "@/app/api/documents/[id]/versions/[versionId]/file/route";
import { POST as restore } from "@/app/api/documents/[id]/versions/[versionId]/restore/route";
import { GET as accessOptions, PATCH as accessUpdate } from "@/app/api/documents/[id]/access/route";

const suite = hasTestDatabase ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const OWNER = "00000000-0000-4000-8000-000000000001";
const I1 = "00000000-0000-4000-8000-000000000011";
const I2 = "00000000-0000-4000-8000-000000000012";
const E1 = "00000000-0000-4000-8000-000000000021";
const E2 = "00000000-0000-4000-8000-000000000022";
const A1 = "00000000-0000-4000-8000-000000000031";
const A2 = "00000000-0000-4000-8000-000000000032";
let pool: PgLikePool;
let classUser: string;
let parentUser: string;
function unwrap<T>(value: { ok: true; data: T } | { ok: false; message: string }): T { if (!value.ok) throw new Error(value.message); return value.data; }
function params(id: string) { return { params: Promise.resolve({ id }) }; }
function vparams(id: string, versionId: string) { return { params: Promise.resolve({ id, versionId }) }; }
function request(path = "/api/documents", method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost${path}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
}
async function login(id: string) {
  const { rows } = await pool.query<{ id: string; role: "admin" | "viewer" | "manager" }>(`SELECT id, role FROM users WHERE id = $1 AND is_active`, [id]);
  state.user = rows[0] ? { ...rows[0], actorId: id, email: "fixture@example.test", displayName: "Fixture", accountPreset: null } : null;
}
async function account(name: string, access: UserAccessConfig = PORTAL_ONLY_ACCESS) {
  const created = await createUserWithAccessQuery(pool, { email: `${name}@example.test`, displayName: name, passwordHash: "fixture", role: "viewer", accountPreset: "custom_access" }, access, OWNER);
  if (!created.ok) throw new Error(created.reason);
  return created.user.id;
}
async function rasterPdf() {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  pdf.addPage([612,792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  return pdf;
}
async function savedDocument(context: DocumentAccessContext = { kind: "owner" }, title = "OWNER_PRIVATE_TITLE", actorId = OWNER, suppliedBlobs?: { original: Blob; current: Blob }) {
  const blobs = suppliedBlobs ?? { original: new Blob(["OWNER_PRIVATE_PDF"]), current: new Blob([Uint8Array.from(await (await rasterPdf()).save()).buffer]) };
  const created = unwrap(await createDocument(pool, { title, filename: context.kind === "owner" ? "OWNER_PRIVATE_FILENAME.pdf" : "class-support.pdf", description: context.kind === "owner" ? "OWNER_PRIVATE_DESCRIPTION" : "Class support", byteSize: blobs.original.size }, actorId, context));
  state.files.set(created.upload.pathname, blobs.original);
  unwrap(await completeDocumentUpload(pool, created.upload.intentId, { pathname: created.upload.pathname, etag: "original", contentType: "application/pdf", size: blobs.original.size }));
  const original = unwrap(await finalizeDocumentVersion(pool, created.document.id, { intentId: created.upload.intentId, idempotencyKey: randomUUID(), exportMode: "source", editorState: { sentinel: "OWNER_PRIVATE_EDITOR" } }, actorId));
  const reservation = unwrap(await createDocumentVersionUpload(pool, created.document.id, { filename: context.kind === "owner" ? "OWNER_PRIVATE_OUTPUT_NAME.pdf" : "class-support.pdf", byteSize: blobs.current.size, baseVersionId: original.id }, actorId));
  state.files.set(reservation.pathname, blobs.current);
  unwrap(await completeDocumentUpload(pool, reservation.intentId, { pathname: reservation.pathname, etag: "secure", contentType: "application/pdf", size: blobs.current.size }));
  const current = unwrap(await finalizeDocumentVersion(pool, created.document.id, { intentId: reservation.intentId, idempotencyKey: randomUUID(), baseVersionId: original.id, exportMode: "secure", editorState: { sentinel: "OWNER_PRIVATE_EDITOR" }, changeSummary: "OWNER_PRIVATE_CHANGE" }, actorId));
  return { id: created.document.id, original, current };
}
async function share(id: string, versionId: string, extra: Record<string, unknown> = {}) {
  await login(OWNER);
  return accessUpdate(request(`/api/documents/${id}/access`, "PATCH", {
    action: "publish", userId: parentUser, versionId, title: "Approved hours", individualId: I1,
    requiredCapabilities: ["hours_budgets.self.read"], reviewedSanitizedOutput: true, ...extra,
  }), params(id));
}

suite("document resource authorization (real PostgreSQL and route handlers)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); state.pool = pool; }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables(); state.files.clear();
    await pool.query(`INSERT INTO users(id,email,display_name,password_hash,role) VALUES($1,'owner@example.test','Owner','fixture','admin')`, [OWNER]);
    await pool.query(`INSERT INTO individuals(id,display_name,normalized_name) VALUES($1,'Person A','person a'),($2,'UNRELATED_PERSON','unrelated person')`, [I1,I2]);
    await pool.query(`INSERT INTO employees(id,display_name,normalized_name) VALUES($1,'Employee A','employee a'),($2,'UNRELATED_EMPLOYEE','unrelated employee')`, [E1,E2]);
    await pool.query(`INSERT INTO agencies(id,code,name) VALUES($1,'DOC_A','Agency A'),($2,'DOC_B','Agency B')`, [A1,A2]);
    classUser = await account("class", { ...CLASS_BILLING_ACCESS, seeAllIndividuals: false, individualIds: [I1] });
    parentUser = await account("parent");
    await pool.query(`INSERT INTO user_portal_roles(user_id,portal_role) VALUES($1,'parent')`, [parentUser]);
    await pool.query(`INSERT INTO user_individual_relationships(user_id,individual_id,relationship_type,capability_grants) VALUES($1,$2,'parent',ARRAY['documents.self.read'])`, [parentUser,I1]);
    await login(OWNER);
  });
  afterAll(closeTestPool);

  it("preserves legacy documents for Owner and filters categories/person scope before search and pagination", async () => {
    const legacy = await savedDocument();
    await pool.query(`UPDATE documents SET access_context = NULL WHERE id = $1`, [legacy.id]);
    const valid = await savedDocument({ kind: "classes", individualId: I1 }, "Allowed classes");
    const other = await savedDocument({ kind: "classes", individualId: I2 }, "UNRELATED_CLASS");
    const payroll = await savedDocument({ kind: "payroll", employeeId: E1 }, "PAYROLL_SENTINEL");
    await login(classUser);
    const response = await listing(request());
    const body = await response.json();
    expect(body.data.map((document: { id: string }) => document.id)).toEqual([valid.id]);
    expect(JSON.stringify(body)).not.toMatch(/OWNER_PRIVATE|UNRELATED|PAYROLL_SENTINEL/);
    expect((await detail(request(), params(valid.id))).status).toBe(200);
    for (const id of [legacy.id, other.id, payroll.id]) expect((await detail(request(), params(id))).status).toBe(404);
    expect((await (await listing(request("/api/documents?query=PRIVATE"))).json()).data).toEqual([]);
    await login(OWNER);
    expect((await detail(request(), params(legacy.id))).status).toBe(200);
    expect((await accessOptions(request(), params(legacy.id))).status).toBe(200);
  });

  it("rehearses the legacy migration without deleting documents, blobs, or versions", async () => {
    const document = await savedDocument();
    await pool.query(`DROP TABLE document_publications`);
    await pool.query(`ALTER TABLE documents DROP COLUMN access_context`);
    const migration = MIGRATIONS.find((item) => item.name === "0046_document_access_context.sql")!;
    for (const statement of migration.sql.split("--> statement-breakpoint").filter((sql) => sql.trim())) await pool.query(statement);
    expect((await pool.query<{ access_context: unknown }>(`SELECT access_context FROM documents WHERE id = $1`, [document.id])).rows[0].access_context).toBeNull();
    expect((await pool.query(`SELECT 1 FROM document_versions WHERE document_id = $1`, [document.id])).rows).toHaveLength(2);
    expect((await pool.query(`SELECT 1 FROM document_blobs WHERE document_id = $1`, [document.id])).rows).toHaveLength(2);
    await login(classUser);
    expect((await detail(request(), params(document.id))).status).toBe(404);
    await login(OWNER);
    expect((await detail(request(), params(document.id))).status).toBe(200);
  });

  it("classifies legacy sources only through Owner review and preserves class editing", async () => {
    const document = await savedDocument();
    await pool.query(`UPDATE documents SET access_context = NULL WHERE id = $1`, [document.id]);
    await login(classUser);
    expect((await accessUpdate(request("/api/documents", "PATCH", { action: "classify", kind: "classes", individualId: I1, reviewedEntireSource: true }), params(document.id))).status).toBe(404);
    await login(OWNER);
    const changed = await accessUpdate(request("/api/documents", "PATCH", { action: "classify", kind: "classes", individualId: I1, reviewedEntireSource: true }), params(document.id));
    expect(changed.status).toBe(200);
    await login(classUser);
    expect((await metadata(request("/api/documents", "PATCH", { title: "Class support PDF" }), params(document.id))).status).toBe(200);
    expect((await history(request(), params(document.id))).status).toBe(200);
    expect((await saveDraft(request("/api/documents", "PUT", { baseVersionId: document.current.id, expectedRevision: null, editorState: { safe: true } }), params(document.id))).status).toBe(200);
  });

  it("blocks every representation and mutation for substituted document IDs without changing state", async () => {
    const document = await savedDocument();
    await login(classUser);
    const paths = [
      () => detail(request(), params(document.id)), () => drafts(request(), params(document.id)), () => history(request(), params(document.id)),
      () => metadata(request("/api/documents", "PATCH", { title: "STOLEN", status: "archived" }), params(document.id)),
      () => saveDraft(request("/api/documents", "PUT", { baseVersionId: document.current.id, expectedRevision: null, editorState: {} }), params(document.id)),
      () => reserveVersion(request("/api/documents", "POST", { filename: "x.pdf", byteSize: 2, baseVersionId: document.current.id }), params(document.id)),
      () => restore(request("/api/documents", "POST", { expectedCurrentVersionId: document.current.id, idempotencyKey: randomUUID() }), vparams(document.id, document.original.id)),
      ...[document.original.id, document.current.id].flatMap((versionId) => ["", "?download=1", "?source=1", "?source=original"].map((query) => () => file(request(`/api/documents/${document.id}/versions/${versionId}/file${query}`), vparams(document.id, versionId)))),
    ];
    for (const invoke of paths) expect((await invoke()).status).toBe(404);
    const row = (await pool.query<{ title: string; status: string }>(`SELECT title,status FROM documents WHERE id = $1`, [document.id])).rows[0];
    expect(row).toEqual({ title: "OWNER_PRIVATE_TITLE", status: "active" });
    expect((await pool.query(`SELECT 1 FROM document_drafts WHERE document_id = $1`, [document.id])).rows).toHaveLength(0);
  });

  it("ordinary viewers receive only current output, without editor state or older originals", async () => {
    const document = await savedDocument({ kind: "classes", individualId: I1 }, "Class PDF");
    const viewer = await account("reader", { ...CLASS_BILLING_ACCESS, canEditDocuments: false });
    await login(viewer);
    const response = await detail(request(), params(document.id));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toMatch(/OWNER_PRIVATE_EDITOR|OWNER_PRIVATE_CHANGE|editorState|parentVersionId|restoredFromVersionId/);
    expect(body.data.versions).toHaveLength(1);
    expect((await drafts(request(), params(document.id))).status).toBe(404);
    expect((await history(request(), params(document.id))).status).toBe(404);
    expect((await file(request(), vparams(document.id, document.original.id))).status).toBe(404);
    expect((await file(request(), vparams(document.id, document.current.id))).status).toBe(200);
    const other = await savedDocument();
    expect((await file(request(), vparams(document.id, other.current.id))).status).toBe(404);
  });

  it("publishes only the approved immutable sanitized version and revokes it on category or relationship denial", async () => {
    const document = await savedDocument();
    expect((await share(document.id, document.current.id)).status).toBe(200);
    await login(parentUser);
    const body = await (await detail(request(), params(document.id))).json();
    expect(body.data.document.title).toBe("Approved hours");
    expect(JSON.stringify(body)).not.toMatch(/OWNER_PRIVATE|editorState|sourceInvoiceId|createdBy.*Owner/);
    expect((await (await listing(request())).json()).data).toHaveLength(1);
    const output = await file(request(), vparams(document.id, document.current.id));
    expect(output.status).toBe(200); expect((await PDFDocument.load(await output.arrayBuffer())).getPageCount()).toBe(1);
    expect(output.headers.get("content-disposition")).not.toContain("OWNER_PRIVATE");
    for (const invoke of [() => history(request(), params(document.id)), () => drafts(request(), params(document.id)), () => file(request(), vparams(document.id, document.original.id)), () => file(request("/api/documents?source=1"), vparams(document.id, document.current.id))]) expect((await invoke()).status).toBe(404);
    await pool.query(`UPDATE user_individual_relationships SET capability_denials = ARRAY['hours_budgets.self.read'] WHERE user_id = $1`, [parentUser]);
    expect((await detail(request(), params(document.id))).status).toBe(404);
    await pool.query(`UPDATE user_individual_relationships SET capability_denials = '{}', is_active = false WHERE user_id = $1`, [parentUser]);
    expect((await detail(request(), params(document.id))).status).toBe(404);
  });

  it("requires explicit portal document approval, exact recipient scope and a secure output", async () => {
    const document = await savedDocument();
    await login(parentUser);
    expect((await listing(request())).status).toBe(403);
    expect((await share(document.id, document.original.id)).status).toBe(400);
    expect((await share(document.id, document.current.id, { individualId: I2 })).status).toBe(400);
    expect((await share(document.id, document.current.id, { reviewedSanitizedOutput: false })).status).toBe(400);
    await pool.query(`UPDATE user_individual_relationships SET capability_grants = '{}' WHERE user_id = $1`, [parentUser]);
    expect((await share(document.id, document.current.id)).status).toBe(400);
    expect((await pool.query(`SELECT 1 FROM document_publications`)).rows).toHaveLength(0);
  });

  it("streams the approved PDF bytes without the retained original's metadata", async () => {
    const original = await PDFDocument.create(); original.setTitle("OWNER_PRIVATE_EMBEDDED_METADATA"); original.addPage().drawText("OWNER_PRIVATE_SOURCE_TEXT");
    const approved = await rasterPdf(); approved.setTitle("OWNER_PRIVATE_CANDIDATE_METADATA");
    await approved.attach(Buffer.from("OWNER_PRIVATE_ATTACHMENT"), "OWNER_PRIVATE.txt");
    const originalBytes = await original.save(); const approvedBytes = await approved.save();
    const document = await savedDocument({ kind: "owner" }, "OWNER_PRIVATE_TITLE", OWNER, {
      original: new Blob([originalBytes.buffer as ArrayBuffer]), current: new Blob([approvedBytes.buffer as ArrayBuffer]),
    });
    expect((await share(document.id, document.current.id)).status).toBe(200);
    await login(parentUser);
    const response = await file(request(), vparams(document.id, document.current.id));
    expect(response.status).toBe(200);
    const deliveredBytes = await response.arrayBuffer();
    const delivered = await PDFDocument.load(deliveredBytes);
    expect(delivered.getPageCount()).toBe(1); expect(delivered.getTitle()).toBeUndefined();
    expect(delivered.catalog.has(PDFName.of("Names"))).toBe(false);
    expect(delivered.catalog.has(PDFName.of("Metadata"))).toBe(false);
    const publication = (await pool.query<{ sanitized_pathname: string; sanitized_byte_size: string; sanitizer_version: number }>(
      `SELECT sanitized_pathname,sanitized_byte_size,sanitizer_version FROM document_publications WHERE document_id = $1`, [document.id],
    )).rows[0];
    expect(publication.sanitized_pathname).toContain("/publications/");
    expect(publication.sanitizer_version).toBe(1);
    expect(Number(publication.sanitized_byte_size)).toBe(Number(response.headers.get("content-length")));
    const sourceFiles = await pool.query<{ storage_pathname: string }>(`SELECT storage_pathname FROM document_blobs WHERE document_id = $1`, [document.id]);
    for (const source of sourceFiles.rows) state.files.set(source.storage_pathname, new Blob(["OWNER_PRIVATE_REPLACED_SOURCE"]));
    const again = await file(request(), vparams(document.id, document.current.id));
    expect(await again.arrayBuffer()).toEqual(deliveredBytes);
    expect((await file(request("/api/documents?source=1"), vparams(document.id, document.current.id))).status).toBe(404);
    expect((await file(request(), vparams(document.id, document.original.id))).status).toBe(404);
  });

  it("rejects a client-declared secure PDF that retains source text, even with Owner approval", async () => {
    const unsafe = await PDFDocument.create(); unsafe.addPage().drawText("OWNER_PRIVATE_HIDDEN_TEXT");
    const bytes = await unsafe.save();
    const document = await savedDocument({ kind: "owner" }, "Unsafe output", OWNER, { original: new Blob(["source"]), current: new Blob([Uint8Array.from(bytes).buffer]) });
    expect((await share(document.id, document.current.id)).status).toBe(400);
    expect((await pool.query(`SELECT 1 FROM document_publications WHERE document_id = $1`, [document.id])).rows).toHaveLength(0);
    await login(parentUser);
    expect((await detail(request(), params(document.id))).status).toBe(404);
  });

  it("creates Class Billing private uploads with server provenance and rejects forged scope", async () => {
    await login(classUser);
    const created = await upload(request("/api/documents", "POST", { title: "Supporting PDF", filename: "support.pdf", byteSize: 17, category: "owner" }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.data.document.accessContext).toEqual({ kind: "private", requiredCapabilities: ["canSeeMoney", "canSeeClassFinancials"] });
    expect((await detail(request(), params(body.data.document.id))).status).toBe(200);
    expect((await upload(request("/api/documents", "POST", { title: "Forged", filename: "x.pdf", byteSize: 17, accessContext: { kind: "classes", individualId: I2 } }))).status).toBe(400);
    expect((await upload(request("/api/documents", "POST", { title: "Forged source", filename: "x.pdf", byteSize: 17, source: `/api/classes/invoices/${randomUUID()}/pdf` }))).status).toBe(404);
    await pool.query(`UPDATE users SET can_see_class_financials = false, can_manage_class_invoices = false WHERE id = $1`, [classUser]);
    expect((await detail(request(), params(body.data.document.id))).status).toBe(404);
  });

  it.each([1, 3])("finalizes a real %i-page library upload using canonical source-page state", async (pageCount) => {
    const source = await PDFDocument.create();
    for (let page = 1; page <= pageCount; page += 1) source.addPage().drawText(`Synthetic source page ${page}`);
    const bytes = await source.save();
    const initialState = await prepareOriginalPdfUpload(bytes);
    await login(classUser);
    const registered = await upload(request("/api/documents", "POST", { title: "Library source", filename: "source.pdf", byteSize: bytes.length }));
    expect(registered.status).toBe(201);
    const { data: reservation } = await registered.json();
    state.files.set(reservation.upload.pathname, new Blob([Uint8Array.from(bytes).buffer]));
    unwrap(await completeDocumentUpload(pool, reservation.upload.intentId, { pathname: reservation.upload.pathname, etag: "source", contentType: "application/pdf", size: bytes.length }));
    const body = { intentId: reservation.upload.intentId, idempotencyKey: randomUUID(), baseVersionId: null, exportMode: "source", changeSummary: "Original uploaded", ...initialState };
    const invalid = { ...body, editorState: { ...initialState.editorState, pageOrder: [] } };
    expect((await finalizeUpload(request("/api/documents", "POST", invalid), params(reservation.document.id))).status).toBe(400);
    const response = await finalizeUpload(request("/api/documents", "POST", body), params(reservation.document.id));
    expect(response.status).toBe(201);
    const saved = (await response.json()).data;
    expect(saved).toMatchObject({ exportMode: "source", pageCount, editorSchemaVersion: 2 });
    expect(parsePdfEditorManifest(saved.editorState)?.pageOrder).toEqual(Array.from({ length: pageCount }, (_, index) => index + 1));
    const reopened = await (await detail(request(), params(reservation.document.id))).json();
    expect(reopened.data.document.status).toBe("active");
    expect(reopened.data.versions[0].editorState).toEqual(initialState.editorState);
    const retainedSource = await file(request("/api/documents?source=1"), vparams(reservation.document.id, saved.id));
    expect(retainedSource.status).toBe(200);
    expect((await PDFDocument.load(await retainedSource.arrayBuffer())).getPageCount()).toBe(pageCount);
  });

  it("inherits a real invoice's person/category for an editable creator-private save without trusting it as a sharing flag", async () => {
    const invoices: string[] = [];
    for (const individualId of [I1, I2]) {
      const budget = unwrap(await createClassBudget(pool, { individualId, startDate: "2026-01-01", endDate: "2026-12-31", authorizedAmount: "1000" }, OWNER));
      const invoice = unwrap(await createClassInvoiceDraft(pool, {
        classBudgetPeriodId: budget.id, invoiceNumber: randomUUID(), invoiceDate: "2026-01-05",
        servicePeriodStart: "2026-01-01", servicePeriodEnd: "2026-01-31",
        lines: [{ serviceDate: "2026-01-02", description: "Class", quantity: "1", unitPrice: "100" }],
      }, OWNER));
      invoices.push(invoice.id);
    }
    await login(classUser);
    const body = { title: "Saved invoice", filename: "invoice.pdf", byteSize: 17 };
    const allowed = await upload(request("/api/documents", "POST", { ...body, source: `/api/classes/invoices/${invoices[0]}/pdf` }));
    expect(allowed.status).toBe(201);
    const created = await allowed.json();
    expect(created.data.document.accessContext).toMatchObject({ kind: "private", individualId: I1, sourceInvoiceId: invoices[0] });
    expect((await detail(request(), params(created.data.document.id))).status).toBe(200);
    expect((await upload(request("/api/documents", "POST", { ...body, source: `/api/classes/invoices/${invoices[1]}/pdf` }))).status).toBe(404);
    const coworker = await account("coworker", CLASS_BILLING_ACCESS);
    await login(coworker);
    expect((await detail(request(), params(created.data.document.id))).status).toBe(404);
  });

  it("saves, reopens, edits again, restores and archives without losing the editable master or source context", async () => {
    const budget = unwrap(await createClassBudget(pool, {
      individualId: I1, startDate: "2026-01-01", endDate: "2026-12-31", authorizedAmount: "1000",
    }, OWNER));
    const invoice = unwrap(await createClassInvoiceDraft(pool, {
      classBudgetPeriodId: budget.id, invoiceNumber: "DOCUMENT-LIFECYCLE", invoiceDate: "2026-01-05",
      servicePeriodStart: "2026-01-01", servicePeriodEnd: "2026-01-31",
      lines: [{ serviceDate: "2026-01-02", description: "Class", unitPrice: "100" }],
    }, OWNER));
    const source = await PDFDocument.create();
    const sourcePage = source.addPage([612, 792]);
    source.setTitle("PRIVATE_EDITABLE_MASTER");
    sourcePage.drawText("Private source text");
    const field = source.getForm().createTextField("attestation");
    field.setText("Original value");
    field.addToPage(sourcePage, { x: 50, y: 50, width: 200, height: 30 });
    const sourceBytes = await source.save();
    const initial = await prepareOriginalPdfUpload(sourceBytes);
    await login(classUser);
    const registration = await upload(request("/api/documents", "POST", {
      title: "Editable invoice", filename: "invoice.pdf", byteSize: sourceBytes.length,
      source: `/api/classes/invoices/${invoice.id}/pdf`,
    }));
    expect(registration.status).toBe(201);
    const { data: created } = await registration.json();
    const id = created.document.id as string;
    const expectedContext = created.document.accessContext;
    expect(expectedContext).toMatchObject({ kind: "private", individualId: I1, sourceInvoiceId: invoice.id });

    async function complete(reservation: { pathname: string; intentId: string }, bytes: Uint8Array) {
      state.files.set(reservation.pathname, new Blob([Uint8Array.from(bytes).buffer]));
      unwrap(await completeDocumentUpload(pool, reservation.intentId, {
        pathname: reservation.pathname, etag: reservation.intentId, contentType: "application/pdf", size: bytes.length,
      }));
    }
    await complete(created.upload, sourceBytes);
    const originalResponse = await finalizeUpload(request("/api/documents", "POST", {
      intentId: created.upload.intentId, idempotencyKey: randomUUID(), exportMode: "source", ...initial,
    }), params(id));
    expect(originalResponse.status).toBe(201);
    const original = (await originalResponse.json()).data;

    const manifest = createPdfEditorManifest({
      overlays: [createTextOverlay(1, { text: "First saved overlay" })], pageOrder: [1],
      pageRotations: { 1: 90 }, formValues: { attestation: "First saved value" }, exportMode: "secure",
    });
    const outputBytes = await (await rasterPdf()).save();
    async function append(baseVersionId: string, editorState: ReturnType<typeof createPdfEditorManifest>) {
      const response = await reserveVersion(request("/api/documents", "POST", {
        filename: "invoice-sanitized.pdf", byteSize: outputBytes.length, baseVersionId,
      }), params(id));
      expect(response.status).toBe(201);
      const reservation = (await response.json()).data;
      await complete(reservation, outputBytes);
      const body = {
        intentId: reservation.intentId, idempotencyKey: randomUUID(), baseVersionId, exportMode: "secure",
        editorSchemaVersion: 2, editorState, pageCount: 1,
      };
      const result = await finalizeUpload(request("/api/documents", "POST", body), params(id));
      expect(result.status).toBe(201);
      const saved = (await result.json()).data;
      const retry = await finalizeUpload(request("/api/documents", "POST", body), params(id));
      expect(retry.status).toBe(201);
      expect((await retry.json()).data.id).toBe(saved.id);
      return saved;
    }
    const first = await append(original.id, manifest);
    const reopened = (await (await detail(request(), params(id))).json()).data;
    expect(reopened.document.accessContext).toEqual(expectedContext);
    expect(reopened.versions[0].editorState).toEqual(manifest);
    const secondManifest = { ...manifest, overlays: [{ ...manifest.overlays[0], text: "Second saved overlay" }], formValues: { attestation: "Second saved value" } };
    expect((await saveDraft(request("/api/documents", "PUT", {
      baseVersionId: first.id, expectedRevision: null, editorSchemaVersion: 2, editorState: secondManifest,
    }), params(id))).status).toBe(200);
    expect((await (await detail(request(), params(id))).json()).data.draft.editorState).toEqual(secondManifest);
    const second = await append(first.id, secondManifest);
    expect(second.versionNumber).toBe(3);
    const retained = await file(request("/api/documents?source=1"), vparams(id, second.id));
    expect(new Uint8Array(await retained.arrayBuffer())).toEqual(sourceBytes);
    const retainedPdf = await PDFDocument.load(sourceBytes);
    expect(retainedPdf.getForm().getTextField("attestation").getText()).toBe("Original value");
    const download = await file(request("/api/documents?download=1"), vparams(id, second.id));
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(outputBytes);

    expect((await share(id, first.id)).status).toBe(200);
    await login(parentUser);
    expect((await (await detail(request(), params(id))).json()).data.document.currentVersionId).toBe(first.id);
    expect((await file(request(), vparams(id, second.id))).status).toBe(404);
    await login(classUser);
    const restoredResponse = await restore(request("/api/documents", "POST", {
      expectedCurrentVersionId: second.id, idempotencyKey: randomUUID(), reason: "Restore the first saved version",
    }), vparams(id, first.id));
    expect(restoredResponse.status).toBe(201);
    const restored = (await restoredResponse.json()).data;
    expect(restored).toMatchObject({ versionNumber: 4, restoredFromVersionId: first.id, editorState: manifest });
    const afterRestore = (await (await detail(request(), params(id))).json()).data;
    expect(afterRestore.document).toMatchObject({ accessContext: expectedContext, originalVersionId: original.id, currentVersionId: restored.id });
    expect(afterRestore.versions).toHaveLength(4);
    expect(afterRestore.draft).toBeNull();
    expect((await metadata(request("/api/documents", "PATCH", { status: "archived" }), params(id))).status).toBe(200);
    expect((await reserveVersion(request("/api/documents", "POST", {
      filename: "blocked.pdf", byteSize: outputBytes.length, baseVersionId: restored.id,
    }), params(id))).status).toBe(409);
    await login(parentUser);
    expect((await detail(request(), params(id))).status).toBe(404);
    expect((await file(request(), vparams(id, first.id))).status).toBe(404);
    expect((await pool.query(`SELECT 1 FROM document_versions WHERE document_id = $1`, [id])).rows).toHaveLength(4);
  });

  it("enforces exact agency, dated membership and current responsibility for published output", async () => {
    const document = await savedDocument();
    const agencyUser = await account("agency");
    await pool.query(`INSERT INTO user_agency_access(user_id,agency_id,portal_role,capability_grants) VALUES($1,$2,'agency',ARRAY['documents.self.read'])`, [agencyUser,A1]);
    await pool.query(`INSERT INTO agency_individuals(agency_id,individual_id,effective_from,manages_budget,bills_services) VALUES($1,$2,'2020-01-01',true,true),($3,$4,'2020-01-01',true,true)`, [A1,I1,A2,I2]);
    const approval = { userId: agencyUser, agencyId: A1, scopeDate: "2026-01-01", requiredCapabilities: ["hours_budgets.agency.read"] };
    expect((await share(document.id, document.current.id, { ...approval, individualId: I2 })).status).toBe(400);
    expect((await share(document.id, document.current.id, approval)).status).toBe(200);
    await login(agencyUser);
    expect((await detail(request(), params(document.id))).status).toBe(200);
    await pool.query(`UPDATE agency_individuals SET manages_budget = false WHERE agency_id = $1`, [A1]);
    expect((await detail(request(), params(document.id))).status).toBe(404);
    await pool.query(`UPDATE agency_individuals SET manages_budget = true, effective_to = '2026-01-02' WHERE agency_id = $1`, [A1]);
    expect((await detail(request(), params(document.id))).status).toBe(404);
  });

  it("keeps every preset out of owner documents while preserving Owner and Class Billing positives", async () => {
    const ownerDoc = await savedDocument();
    const classDoc = await savedDocument({ kind: "classes", individualId: I1 }, "Classes");
    for (const preset of ACCOUNT_PRESETS) {
      const created = await createUserWithAccessQuery(pool, { email: `matrix-${preset.id}@example.test`, displayName: preset.label, passwordHash: "fixture", role: preset.role, accountPreset: preset.id }, preset.access ?? PORTAL_ONLY_ACCESS, OWNER);
      if (!created.ok) throw new Error(created.reason);
      await login(created.user.id);
      expect((await detail(request(), params(ownerDoc.id))).status, preset.id).toBe(preset.id === "owner" ? 200 : 404);
      expect((await detail(request(), params(classDoc.id))).status, preset.id).toBe(["owner", "office_manager", "class_billing"].includes(preset.id) ? 200 : 404);
    }
  });

  it.each(["scheduler", "staffing_manager"] as const)("limits %s approved PDFs to explicitly granted schedule/hour content and exact agency scope", async (role) => {
    const document = await savedDocument();
    const privateDocument = await savedDocument();
    const userId = await account(`documents-${role}`);
    await pool.query(`INSERT INTO user_agency_access(user_id,agency_id,portal_role) VALUES($1,$2,$3)`, [userId,A1,role]);
    await pool.query(`INSERT INTO agency_individuals(agency_id,individual_id,effective_from,manages_budget,bills_services) VALUES($1,$2,'2020-01-01',true,true),($3,$4,'2020-01-01',true,true)`, [A1,I1,A2,I2]);
    const approval = { userId, agencyId: A1, scopeDate: "2026-01-01", requiredCapabilities: ["schedules.agency.read", "hours_budgets.agency.read"] };
    expect((await share(document.id, document.current.id, approval)).status).toBe(400);
    await pool.query(`UPDATE user_agency_access SET capability_grants=ARRAY['documents.self.read'] WHERE user_id=$1`, [userId]);
    for (const restriction of [
      { individualId: I2 }, { agencyId: A2 }, { scopeDate: "2019-01-01" },
      { requiredCapabilities: ["schedules.agency.read", "financials.agency.billed_totals.read"] },
      { requiredCapabilities: ["hours_budgets.agency.read", "dollar_budgets.agency.read"] },
    ]) expect((await share(document.id, document.current.id, { ...approval, ...restriction })).status).toBe(400);
    expect((await share(document.id, document.current.id, approval)).status).toBe(200);
    await login(userId);
    expect((await detail(request(), params(document.id))).status).toBe(200);
    expect((await file(request(), vparams(document.id, document.current.id))).status).toBe(200);
    expect((await (await listing(request())).json()).data.map((item: { id: string }) => item.id)).toEqual([document.id]);
    for (const invoke of [
      () => detail(request(), params(privateDocument.id)), () => drafts(request(), params(document.id)),
      () => history(request(), params(document.id)), () => file(request(), vparams(document.id, document.original.id)),
      () => file(request("/api/documents?source=original"), vparams(document.id, document.current.id)),
    ]) expect((await invoke()).status).toBe(404);
    for (const capability of ["hours_budgets.agency.read", "documents.self.read"]) {
      await pool.query(`UPDATE user_agency_access SET capability_denials=ARRAY[$2::text] WHERE user_id=$1`, [userId,capability]);
      expect((await detail(request(), params(document.id))).status).toBe(404);
    }
    await pool.query(`UPDATE user_agency_access SET capability_denials='{}' WHERE user_id=$1`, [userId]);
    await pool.query(`UPDATE agency_individuals SET manages_budget=false WHERE agency_id=$1`, [A1]);
    expect((await detail(request(), params(document.id))).status).toBe(404);
    expect((await share(document.id, document.current.id, { ...approval, requiredCapabilities: ["schedules.agency.read"] })).status).toBe(200);
    await login(userId);
    expect((await detail(request(), params(document.id))).status).toBe(200);
    await pool.query(`UPDATE agency_individuals SET effective_to='2026-01-02' WHERE agency_id=$1`, [A1]);
    expect((await detail(request(), params(document.id))).status).toBe(404);
  });
});
