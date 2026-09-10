import { del, get, head, put } from "@vercel/blob";

import { localDocumentTestRoot, inspectLocalDocument, readLocalDocument, deleteLocalDocument, writeLocalDocument } from "./local-test-storage";

const DEFAULT_MAX_PDF_BYTES = 100 * 1024 * 1024;
const ABSOLUTE_MAX_PDF_BYTES = 500 * 1024 * 1024;

export interface DocumentBlobMetadata {
  pathname: string;
  etag: string;
  contentType: string;
  size: number;
}

export function maxPdfUploadBytes(): number {
  const configured = Number(process.env.MAX_PDF_UPLOAD_BYTES ?? DEFAULT_MAX_PDF_BYTES);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_PDF_BYTES;
  return Math.min(Math.floor(configured), ABSOLUTE_MAX_PDF_BYTES);
}

export function documentUploadPathname(documentId: string, intentId: string): string {
  return `documents/${documentId}/uploads/${intentId}.pdf`;
}

export function hasDocumentStorage(): boolean {
  return Boolean(localDocumentTestRoot() || process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

/** Keep server reads/writes in the same store as signed browser uploads. */
export function privateDocumentStorageToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) throw new Error("Private document storage is not configured.");
  return token;
}

export async function inspectPrivateDocumentBlob(pathname: string): Promise<DocumentBlobMetadata> {
  if (localDocumentTestRoot()) return inspectLocalDocument(pathname);
  const blob = await head(pathname, { token: privateDocumentStorageToken() });
  return {
    pathname: blob.pathname,
    etag: blob.etag,
    contentType: blob.contentType,
    size: blob.size,
  };
}

export async function readPrivateDocumentBlob(pathname: string, ifNoneMatch?: string | null) {
  if (localDocumentTestRoot()) return readLocalDocument(pathname, ifNoneMatch);
  return get(pathname, {
    token: privateDocumentStorageToken(),
    access: "private",
    ifNoneMatch: ifNoneMatch || undefined,
  });
}

export async function deletePrivateDocumentBlob(pathname: string): Promise<void> {
  if (localDocumentTestRoot()) return deleteLocalDocument(pathname);
  await del(pathname, { token: privateDocumentStorageToken() });
}

/** Server-created immutable publication artifact, never a client upload path. */
export async function writePrivateDocumentPublication(pathname: string, bytes: Uint8Array): Promise<void> {
  if (!/^documents\/[0-9a-f-]{36}\/publications\/[0-9a-f-]{36}\.pdf$/i.test(pathname)) throw new Error("Invalid publication path.");
  if (localDocumentTestRoot()) return writeLocalDocument(pathname, bytes);
  await put(pathname, Buffer.from(bytes), {
    token: privateDocumentStorageToken(),
    access: "private", contentType: "application/pdf", addRandomSuffix: false, allowOverwrite: false,
  });
}

export async function readDocumentBytesForPublication(pathname: string): Promise<Uint8Array> {
  const blob = await readPrivateDocumentBlob(pathname);
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw new Error("The saved PDF could not be read.");
  const reader = blob.stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 100 * 1024 * 1024) { await reader.cancel(); throw new Error("This PDF is too large to approve. Split it into smaller documents."); }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); }
}
