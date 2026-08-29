import { type NextRequest } from "next/server";
import { writeAudit } from "@/lib/auth/users";
import { getDocumentVersionFile } from "@/lib/data/documents";
import { accessibleDocument } from "@/lib/document-route-helpers";
import { readPrivateDocumentBlob } from "@/lib/documents/document-storage";
import { jsonError, redactError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function contentDisposition(filename: string, download: boolean): string {
  const fallback = filename.replace(/[^a-z0-9._ -]+/gi, "_").replace(/["\r\n]/g, "_") || "document.pdf";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await params;
  try {
    const found = await accessibleDocument(id);
    if ("error" in found) return found.error;
    const file = await getDocumentVersionFile(found.access.pool, id, versionId);
    if (!file) return jsonError("That document version was not found.", 404);
    const blob = await readPrivateDocumentBlob(file.pathname, request.headers.get("if-none-match"));
    if (!blob) return jsonError("That document file was not found.", 404);
    if (blob.statusCode === 304) {
      return new Response(null, {
        status: 304,
        headers: { etag: blob.blob.etag, "cache-control": "private, no-cache, max-age=0" },
      });
    }
    if (blob.statusCode !== 200 || !blob.stream) return jsonError("That document file was not found.", 404);
    const download = request.nextUrl.searchParams.get("download") === "1";
    await writeAudit(found.access.pool, {
      userId: found.access.user.id,
      action: download ? "document_version_downloaded" : "document_version_opened",
      entityType: "document",
      entityId: id,
      metadata: { versionId },
    });
    return new Response(blob.stream, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(file.byteSize),
        "content-disposition": contentDisposition(file.filename, download),
        "cache-control": "private, no-store, max-age=0",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
        etag: blob.blob.etag,
      },
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not open that document file."), 500);
  }
}
