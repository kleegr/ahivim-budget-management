import { type NextRequest } from "next/server";
import { accessibleDocument } from "@/lib/document-route-helpers";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { createDocumentVersionUpload } from "@/lib/manage/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    return resultResponse(await createDocumentVersionUpload(found.access.pool, id, {
      filename: String(body.filename ?? ""),
      byteSize: Number(body.byteSize),
      baseVersionId: String(body.baseVersionId ?? ""),
    }, found.access.user.id), 201);
  } catch (error) {
    return jsonError(redactError(error, "Could not reserve that PDF upload."), 500);
  }
}
