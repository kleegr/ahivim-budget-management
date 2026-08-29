import { type NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { apiDocumentEditorUser } from "@/lib/auth/document-access";
import {
  hasDocumentStorage,
  inspectPrivateDocumentBlob,
} from "@/lib/documents/document-storage";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";
import type { PgLikePool } from "@/lib/import/commit";
import {
  authorizeDocumentUploadToken,
  completeDocumentUpload,
  parseDocumentUploadTokenPayload,
} from "@/lib/manage/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
