import { del, get, head } from "@vercel/blob";

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
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

export async function inspectPrivateDocumentBlob(pathname: string): Promise<DocumentBlobMetadata> {
  const blob = await head(pathname);
  return {
    pathname: blob.pathname,
    etag: blob.etag,
    contentType: blob.contentType,
    size: blob.size,
  };
}

export async function readPrivateDocumentBlob(pathname: string, ifNoneMatch?: string | null) {
  return get(pathname, {
    access: "private",
    ifNoneMatch: ifNoneMatch || undefined,
  });
}

export async function deletePrivateDocumentBlob(pathname: string): Promise<void> {
  await del(pathname);
}
