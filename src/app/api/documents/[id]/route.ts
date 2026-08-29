import { type NextRequest, NextResponse } from "next/server";
import { accessibleDocument } from "@/lib/document-route-helpers";
import { getDocumentDraft, listDocumentVersions } from "@/lib/data/documents";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { updateDocumentMetadata } from "@/lib/manage/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const found = await accessibleDocument(id);
    if ("error" in found) return found.error;
    const [versions, draft] = await Promise.all([
      listDocumentVersions(found.access.pool, id),
      getDocumentDraft(found.access.pool, id, found.access.user.id),
    ]);
    return NextResponse.json({ ok: true, data: { document: found.document, versions, draft } });
  } catch (error) {
    return jsonError(redactError(error, "Could not load that document."), 500);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  try {
    const found = await accessibleDocument(id);
    if ("error" in found) return found.error;
    const body = await readJson(request);
    const status = body.status === "active" || body.status === "archived" ? body.status : undefined;
    if (body.status !== undefined && status === undefined) return jsonError("Choose active or archived status.", 400);
    return resultResponse(await updateDocumentMetadata(found.access.pool, id, {
      title: body.title === undefined ? undefined : String(body.title),
      description: body.description === undefined ? undefined : body.description === null ? null : String(body.description),
      category: body.category === undefined ? undefined : String(body.category),
      status,
    }, found.access.user.id, typeof body.reason === "string" ? body.reason : null));
  } catch (error) {
    return jsonError(redactError(error, "Could not update that document."), 500);
  }
}
