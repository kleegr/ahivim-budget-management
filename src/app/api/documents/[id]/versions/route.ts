import { type NextRequest, NextResponse } from "next/server";
import { accessibleDocument } from "@/lib/document-route-helpers";
import { listDocumentVersions, type DocumentExportMode } from "@/lib/data/documents";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { finalizeDocumentVersion } from "@/lib/manage/documents";

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
    return NextResponse.json({ ok: true, data: await listDocumentVersions(found.access.pool, id) });
  } catch (error) {
    return jsonError(redactError(error, "Could not load document history."), 500);
  }
}

export async function POST(
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
    const exportMode = typeof body.exportMode === "string" ? body.exportMode as DocumentExportMode : undefined;
    const editorState = body.editorState && typeof body.editorState === "object" && !Array.isArray(body.editorState)
      ? body.editorState as Record<string, unknown>
      : {};
    return resultResponse(await finalizeDocumentVersion(found.access.pool, id, {
      intentId: String(body.intentId ?? ""),
      idempotencyKey: String(body.idempotencyKey ?? ""),
      baseVersionId: body.baseVersionId === null ? null : typeof body.baseVersionId === "string" ? body.baseVersionId : undefined,
      exportMode,
      editorSchemaVersion: body.editorSchemaVersion === undefined ? 1 : Number(body.editorSchemaVersion),
      editorState,
      pageCount: body.pageCount === null || body.pageCount === undefined ? null : Number(body.pageCount),
      changeSummary: typeof body.changeSummary === "string" ? body.changeSummary : null,
      checksumSha256: typeof body.checksumSha256 === "string" ? body.checksumSha256 : null,
    }, found.access.user.id), 201);
  } catch (error) {
    return jsonError(redactError(error, "Could not save that document version."), 500);
  }
}
