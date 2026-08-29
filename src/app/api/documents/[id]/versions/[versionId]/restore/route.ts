import { type NextRequest } from "next/server";
import { accessibleDocument } from "@/lib/document-route-helpers";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { restoreDocumentVersion } from "@/lib/manage/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id, versionId } = await params;
  try {
    const found = await accessibleDocument(id);
    if ("error" in found) return found.error;
    const body = await readJson(request);
    return resultResponse(await restoreDocumentVersion(found.access.pool, id, versionId, {
      expectedCurrentVersionId: String(body.expectedCurrentVersionId ?? ""),
      idempotencyKey: String(body.idempotencyKey ?? ""),
      reason: typeof body.reason === "string" ? body.reason : null,
    }, found.access.user.id), 201);
  } catch (error) {
    return jsonError(redactError(error, "Could not restore that document version."), 500);
  }
}
