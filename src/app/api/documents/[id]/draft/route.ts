import { type NextRequest, NextResponse } from "next/server";
import { accessibleDocument } from "@/lib/document-route-helpers";
import { getDocumentDraft } from "@/lib/data/documents";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { discardDocumentDraft, saveDocumentDraft } from "@/lib/manage/documents";

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
    return NextResponse.json({
      ok: true,
      data: await getDocumentDraft(found.access.pool, id, found.access.user.id),
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not load that draft."), 500);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  try {
    const found = await accessibleDocument(id, "edit");
    if ("error" in found) return found.error;
    const body = await readJson(request);
    const expectedRevision = body.expectedRevision === null ? null : Number(body.expectedRevision);
    const editorState = body.editorState && typeof body.editorState === "object" && !Array.isArray(body.editorState)
      ? body.editorState as Record<string, unknown>
      : {};
    return resultResponse(await saveDocumentDraft(found.access.pool, id, {
      baseVersionId: String(body.baseVersionId ?? ""),
      expectedRevision,
      editorSchemaVersion: body.editorSchemaVersion === undefined ? 1 : Number(body.editorSchemaVersion),
      editorState,
    }, found.access.user.id));
  } catch (error) {
    return jsonError(redactError(error, "Could not autosave that document."), 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  try {
    const found = await accessibleDocument(id, "edit");
    if ("error" in found) return found.error;
    return resultResponse(await discardDocumentDraft(found.access.pool, id, found.access.user.id));
  } catch (error) {
    return jsonError(redactError(error, "Could not discard that draft."), 500);
  }
}
