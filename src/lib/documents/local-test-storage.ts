import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Explicit isolated test storage. It can never replace Blob in a deployment. */
export function localDocumentTestRoot(): string | null {
  const configured = process.env.AHIVIM_TEST_DOCUMENT_STORAGE_DIR?.trim();
  if (!configured) return null;
  if (process.env.VERCEL || process.env.BLOB_READ_WRITE_TOKEN) throw new Error("Test document storage cannot run with deployed or Blob resources.");
  const database = new URL(process.env.DATABASE_URL ?? "invalid:");
  if (!["postgres:", "postgresql:"].includes(database.protocol) || database.search.length > 0
    || !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname)
    || !/\/(?:ahivim_)?(?:test|e2e|report)(?:_[a-z0-9_]+)?$/i.test(database.pathname)
    || !path.isAbsolute(configured)) throw new Error("Test document storage requires an isolated local test database and an absolute directory.");
  return path.resolve(configured);
}

function localPath(pathname: string): string {
  const root = localDocumentTestRoot();
  if (!root || !/^documents\/[0-9a-f-]{36}\/(uploads|publications)\/[0-9a-f-]{36}\.pdf$/i.test(pathname)) throw new Error("Invalid isolated document path.");
  const resolved = path.resolve(root, pathname);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid isolated document path.");
  return resolved;
}

export async function inspectLocalDocument(pathname: string) {
  const bytes = await readFile(localPath(pathname));
  return { pathname, contentType: "application/pdf", size: bytes.length, etag: `"${createHash("sha256").update(bytes).digest("hex")}"` };
}

export async function readLocalDocument(pathname: string, ifNoneMatch?: string | null) {
  const bytes = await readFile(localPath(pathname));
  const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
  const matched = ifNoneMatch === etag;
  return { statusCode: matched ? 304 : 200, blob: { etag }, stream: matched ? null : new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}

export async function writeLocalDocument(pathname: string, bytes: Uint8Array) {
  const destination = localPath(pathname);
  if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") throw new Error("Upload a valid PDF file.");
  await mkdir(path.dirname(destination), { recursive: true });
  try { await writeFile(destination, bytes, { flag: "wx" }); }
  catch (error) {
    // Retrying the same reserved upload is safe; a different payload is not.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !Buffer.from(bytes).equals(await readFile(destination))) throw error;
  }
}

export async function deleteLocalDocument(pathname: string) { await unlink(localPath(pathname)); }
