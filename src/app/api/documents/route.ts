import { type NextRequest, NextResponse } from "next/server";
import { apiDocumentEditorUser, apiDocumentViewerUser } from "@/lib/auth/document-access";
import { listDocuments, type DocumentStatus } from "@/lib/data/documents";
import { hasDocumentStorage } from "@/lib/documents/document-storage";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { createDocument } from "@/lib/manage/documents";
import { creationDocumentContext } from "@/lib/manage/document-policy";
import { listPublishedDocuments } from "@/lib/auth/document-publications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await apiDocumentViewerUser();
  if (!access) return jsonError("Document access required", 403);
  const rawStatus = request.nextUrl.searchParams.get("status");
  const status: DocumentStatus | null = rawStatus === "uploading" || rawStatus === "active" || rawStatus === "archived"
    ? rawStatus
    : null;
  try {
    const query = request.nextUrl.searchParams.get("query");
    if (access.external) {
      const documents = await listPublishedDocuments(access);
      return NextResponse.json({ ok: true, data: documents
        .filter((document) => (!status || document.status === status) && (!query || document.title.toLowerCase().includes(query.toLowerCase())))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100) });
    }
    return NextResponse.json({
      ok: true,
      data: (await listDocuments(access.pool, {
        status,
        query,
      }, access.scope)).map((document) => access.scope.canEditDocuments ? document : { ...document, originalVersionId: null, accessContext: null }),
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not load documents."), 500);
  }
}

export async function POST(request: NextRequest) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const access = await apiDocumentEditorUser();
  if (!access) return jsonError("Document access required", 403);
  if (!hasDocumentStorage()) {
    return jsonError("Private document storage is not configured. Ask an administrator to connect document storage.", 503);
  }
  const body = await readJson(request);
  try {
    if (body.accessContext !== undefined || body.shared !== undefined || body.individualId !== undefined || body.agencyId !== undefined) {
      return jsonError("Document access is assigned from its source or by the Owner.", 400);
    }
    const context = await creationDocumentContext(access, body.source);
    if (!context.ok) return resultResponse(context);
    return resultResponse(await createDocument(access.pool, {
      title: String(body.title ?? ""),
      description: body.description === null ? null : typeof body.description === "string" ? body.description : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
      filename: String(body.filename ?? ""),
      byteSize: Number(body.byteSize),
    }, access.user.id, context.data), 201);
  } catch (error) {
    return jsonError(redactError(error, "Could not create that document."), 500);
  }
}
