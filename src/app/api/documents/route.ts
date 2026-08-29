import { type NextRequest, NextResponse } from "next/server";
import { apiDocumentEditorUser } from "@/lib/auth/document-access";
import { listDocuments, type DocumentStatus } from "@/lib/data/documents";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { createDocument } from "@/lib/manage/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await apiDocumentEditorUser();
  if (!access) return jsonError("Document access required", 403);
  const rawStatus = request.nextUrl.searchParams.get("status");
  const status: DocumentStatus | null = rawStatus === "uploading" || rawStatus === "active" || rawStatus === "archived"
    ? rawStatus
    : null;
  try {
    return NextResponse.json({
      ok: true,
      data: await listDocuments(access.pool, {
        status,
        query: request.nextUrl.searchParams.get("query"),
      }),
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
  const body = await readJson(request);
  try {
    return resultResponse(await createDocument(access.pool, {
      title: String(body.title ?? ""),
      description: body.description === null ? null : typeof body.description === "string" ? body.description : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
      filename: String(body.filename ?? ""),
      byteSize: Number(body.byteSize),
    }, access.user.id), 201);
  } catch (error) {
    return jsonError(redactError(error, "Could not create that document."), 500);
  }
}
