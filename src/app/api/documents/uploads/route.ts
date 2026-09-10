import { type NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { apiDocumentEditorUser } from "@/lib/auth/document-access";
import {
  hasDocumentStorage,
  inspectPrivateDocumentBlob,
  privateDocumentStorageToken,
} from "@/lib/documents/document-storage";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";
import type { PgLikePool } from "@/lib/import/commit";
import { getDocument } from "@/lib/data/documents";
import { canAccessDocumentSource } from "@/lib/auth/document-policy";
import { localDocumentTestRoot, writeLocalDocument } from "@/lib/documents/local-test-storage";
import {
  authorizeDocumentUploadToken,
  completeDocumentUpload,
  parseDocumentUploadTokenPayload,
} from "@/lib/manage/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Exercises the same reservation, authorization and finalization in isolated tests. */
export async function PUT(request: NextRequest) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  if (!localDocumentTestRoot()) return jsonError("That upload transport is unavailable.", 404);
  const access = await apiDocumentEditorUser();
  if (!access || access.external) return jsonError("Document access required.", 403);
  try {
    const pathname = request.headers.get("x-document-pathname") ?? "";
    const intentId = request.headers.get("x-document-intent");
    const authorization = await authorizeDocumentUploadToken(access.pool, { pathname, clientPayload: JSON.stringify({ intentId }), actorId: access.user.id });
    if (!authorization.ok) return jsonError(authorization.message, 400);
    const intent = authorization.data.intent;
    const document = await getDocument(access.pool, intent.documentId);
    if (!document || !canAccessDocumentSource(access.scope, document)) return jsonError("That document was not found.", 404);
    const reader = request.body?.getReader();
    if (!reader) return jsonError("Upload a PDF file.", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > intent.expectedByteSize) { await reader.cancel(); return jsonError("The PDF exceeds its reserved size.", 400); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    if (size !== intent.expectedByteSize) return jsonError("The PDF upload is incomplete. Try again.", 400);
    await writeLocalDocument(pathname, Buffer.concat(chunks));
    const completed = await completeDocumentUpload(access.pool, intent.id, await inspectPrivateDocumentBlob(pathname));
    if (!completed.ok) return jsonError(completed.message, 400);
    return NextResponse.json({ ok: true });
  } catch (error) { return jsonError(redactError(error, "Could not save that PDF upload."), 400); }
}

export async function POST(request: NextRequest) {
  let body: HandleUploadBody;
  try {
    body = await request.json() as HandleUploadBody;
  } catch {
    return jsonError("Send a valid document-upload request.", 400);
  }

  if (body.type === "blob.generate-client-token") {
    const cross = sameOriginOrFail(request);
    if (cross) return cross;
  }
  if (!hasDocumentStorage()) return jsonError("Private document storage is not configured.", 503);

  try {
    const response = await handleUpload({
      token: privateDocumentStorageToken(),
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const access = await apiDocumentEditorUser();
        if (!access) throw new Error("Document access required.");
        const authorization = await authorizeDocumentUploadToken(access.pool, {
          pathname,
          clientPayload,
          actorId: access.user.id,
        });
        if (!authorization.ok) throw new Error(authorization.message);
        const document = await getDocument(access.pool, authorization.data.intent.documentId);
        if (access.external || !document || !canAccessDocumentSource(access.scope, document)) throw new Error("That document was not found.");
        return {
          allowedContentTypes: ["application/pdf"],
          maximumSizeInBytes: authorization.data.intent.expectedByteSize,
          validUntil: new Date(authorization.data.intent.expiresAt).getTime(),
          addRandomSuffix: false,
          allowOverwrite: false,
          cacheControlMaxAge: 60,
          tokenPayload: authorization.data.tokenPayload,
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const intentId = parseDocumentUploadTokenPayload(tokenPayload);
        if (!intentId) throw new Error("Upload callback is missing its reservation.");
        if (blob.pathname === "") throw new Error("Upload callback is missing its pathname.");
        const database = await import("@/lib/db");
        const metadata = await inspectPrivateDocumentBlob(blob.pathname);
        const completed = await completeDocumentUpload(
          database.getPool() as unknown as PgLikePool,
          intentId,
          metadata,
        );
        if (!completed.ok) throw new Error(completed.message);
      },
    });
    return NextResponse.json(response);
  } catch (error) {
    return jsonError(redactError(error, "Could not authorize that PDF upload."), 400);
  }
}
