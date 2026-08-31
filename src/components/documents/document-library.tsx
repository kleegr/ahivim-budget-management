"use client";

import { upload } from "@vercel/blob/client";
import {
  Archive,
  Clock3,
  FileText,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Search,
  Upload,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MAX_PDF_BYTES = 100 * 1024 * 1024;

interface DocumentRecord {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: "uploading" | "active" | "archived";
  originalVersionId: string | null;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  currentFilename: string | null;
  currentByteSize: number | null;
  createdBy: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UploadReservation {
  document: DocumentRecord;
  upload: {
    intentId: string;
    pathname: string;
    handleUploadUrl: string;
    maximumSizeInBytes: number;
    expiresAt: string;
  };
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body instanceof FormData
      ? init.headers
      : { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok || !body.ok || body.data === undefined) {
    throw new Error(body.error || "The document request could not be completed.");
  }
  return body.data;
}

function fileTitle(filename: string): string {
  return filename.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled PDF";
}

function formatBytes(value: number | null): string {
  if (!value) return "-";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function DocumentLibrary() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [status, setStatus] = useState<"active" | "uploading" | "archived">("active");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ status });
      if (query.trim()) params.set("query", query.trim());
      setDocuments(await api<DocumentRecord[]>(`/api/documents?${params}`));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The document library could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [query, status]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadDocuments(), query ? 250 : 0);
    return () => window.clearTimeout(timeout);
  }, [loadDocuments, query]);

  const counts = useMemo(() => ({
    active: status === "active" ? documents.length : null,
    uploading: status === "uploading" ? documents.length : null,
    archived: status === "archived" ? documents.length : null,
  }), [documents.length, status]);

  const openFile = async (file: File) => {
    setError(null);
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      setError("Choose a PDF file.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setError("This PDF is larger than 100 MB.");
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    try {
      const reservation = await api<UploadReservation>("/api/documents", {
        method: "POST",
        body: JSON.stringify({
          title: fileTitle(file.name),
          filename: file.name,
          byteSize: file.size,
          category: "general",
        }),
      });
      await upload(reservation.upload.pathname, file, {
        access: "private",
        handleUploadUrl: reservation.upload.handleUploadUrl,
        clientPayload: JSON.stringify({ intentId: reservation.upload.intentId }),
        multipart: true,
        onUploadProgress: ({ percentage }) => setUploadProgress(Math.round(percentage)),
      });
      const finalizeBody = JSON.stringify({
          intentId: reservation.upload.intentId,
          idempotencyKey: crypto.randomUUID(),
          baseVersionId: null,
          exportMode: "source",
          editorSchemaVersion: 1,
          editorState: {
            schemaVersion: 1,
            overlays: [],
            pageOrder: [],
            pageRotations: {},
            formValues: {},
            exportMode: "standard",
          },
          changeSummary: "Original uploaded",
        });
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          await api(`/api/documents/${reservation.document.id}/versions`, {
            method: "POST",
            body: finalizeBody,
          });
          break;
        } catch (finalizeError) {
          const message = finalizeError instanceof Error ? finalizeError.message : "";
          if (!/upload has not completed/i.test(message) || attempt === 7) throw finalizeError;
          await new Promise((resolve) => window.setTimeout(resolve, 300 + attempt * 250));
        }
      }
      router.push(`/documents/pdf-editor?document=${reservation.document.id}`);
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "The PDF could not be saved.";
      setError(`${message} Any interrupted record is available under Incomplete.`);
      setUploading(false);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const setArchived = async (document: DocumentRecord, archived: boolean) => {
    setMenuId(null);
    try {
      await api(`/api/documents/${document.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: archived ? "archived" : "active",
          reason: archived ? "Archived from the document library" : "Restored from the document library",
        }),
      });
      await loadDocuments();
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : "The document could not be updated.");
    }
  };

  return (
    <div className="min-w-0 max-w-full space-y-5 overflow-x-clip">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-rule)] pb-5">
        <div>
          <p className="eyebrow">Documents</p>
          <h1 className="display mt-1 text-2xl text-[var(--color-ink)] sm:text-3xl">Document library</h1>
          <p className="mt-2 text-sm text-[var(--color-ink-soft)]">PDF originals, edited versions, and recoverable history.</p>
        </div>
        <button type="button" className="btn btn-primary" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
          {uploading ? `Uploading ${uploadProgress}%` : "Upload PDF"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void openFile(file);
          }}
        />
      </header>

      {error ? (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]" role="alert">{error}</div>
      ) : null}

      <section aria-label="Document filters" className="flex min-w-0 flex-wrap items-center gap-3 border-b border-[var(--color-rule)] pb-4">
        <div className="segmented-control scroll-thin grid w-full min-w-0 grid-cols-3 overflow-x-auto [&>button]:flex-1 sm:w-auto" role="group" aria-label="Document status">
          <button type="button" aria-pressed={status === "active"} onClick={() => setStatus("active")}>Documents{counts.active === null ? "" : ` ${counts.active}`}</button>
          <button type="button" aria-pressed={status === "uploading"} onClick={() => setStatus("uploading")}>Incomplete{counts.uploading === null ? "" : ` ${counts.uploading}`}</button>
          <button type="button" aria-pressed={status === "archived"} onClick={() => setStatus("archived")}>Archived{counts.archived === null ? "" : ` ${counts.archived}`}</button>
        </div>
        <label className="relative w-full min-w-0 flex-1 sm:w-auto sm:min-w-56 sm:max-w-sm">
          <span className="sr-only">Search documents</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" aria-hidden />
          <input className="input w-full" style={{ paddingLeft: "2.25rem" }} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search documents" />
        </label>
      </section>

      <section aria-label={status === "active" ? "Saved documents" : status === "uploading" ? "Incomplete uploads" : "Archived documents"}>
        {loading ? (
          <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-[var(--color-ink-soft)]">
            <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden /> Loading documents
          </div>
        ) : documents.length === 0 ? (
          <div className="grid min-h-72 place-items-center border-b border-[var(--color-rule)] py-12 text-center">
            <div className="max-w-sm">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-md bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
                {status === "active" ? <FolderOpen className="h-6 w-6" aria-hidden /> : <Archive className="h-6 w-6" aria-hidden />}
              </div>
              <h2 className="mt-4 text-lg font-semibold">{status === "archived" ? "No archived documents" : status === "uploading" ? "No incomplete uploads" : "Your document library is ready"}</h2>
              <p className="mt-2 text-sm text-[var(--color-ink-soft)]">{status === "archived" ? "Archived PDFs will remain recoverable here." : status === "uploading" ? "Interrupted uploads appear here so they can be removed and uploaded again." : "Upload a PDF to preserve its original and begin a tracked editing history."}</p>
              {status === "active" ? <button type="button" className="btn btn-secondary mt-5" onClick={() => fileInputRef.current?.click()}><Upload className="h-4 w-4" aria-hidden /> Upload PDF</button> : null}
            </div>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-[var(--color-rule)] sm:hidden" data-document-mobile-list>
              {documents.map((document) => (
                <li key={document.id} className="relative py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <button
                      type="button"
                      className="flex min-h-11 min-w-0 flex-1 items-start gap-3 text-left disabled:cursor-default"
                      disabled={!document.currentVersionId}
                      onClick={() => router.push(`/documents/pdf-editor?document=${document.id}`)}
                    >
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-[var(--color-primary-tint)] text-[var(--color-primary)]"><FileText className="h-4 w-4" aria-hidden /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-words font-semibold text-[var(--color-ink)]">{document.title}</span>
                        <span className="mt-0.5 block break-all text-xs text-[var(--color-ink-faint)]">{document.currentFilename ?? "PDF upload pending"}</span>
                      </span>
                    </button>
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon h-11 w-11"
                        aria-label={`Actions for ${document.title}`}
                        aria-expanded={menuId === document.id}
                        aria-haspopup="menu"
                        title="Document actions"
                        onClick={() => setMenuId((current) => current === document.id ? null : document.id)}
                      >
                        <MoreHorizontal className="h-4 w-4" aria-hidden />
                      </button>
                      {menuId === document.id ? (
                        <div className="absolute right-0 top-11 z-20 w-44 rounded-md border border-[var(--color-rule-strong)] bg-white p-1 text-left shadow-lg" role="menu">
                          {document.currentVersionId ? <button type="button" role="menuitem" className="w-full rounded px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)]" onClick={() => router.push(`/documents/pdf-editor?document=${document.id}`)}>Open editor</button> : null}
                          {status === "archived" && !document.currentVersionId ? null : (
                            <button type="button" role="menuitem" className="w-full rounded px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)]" onClick={() => void setArchived(document, status !== "archived")}>{status === "archived" ? "Restore to library" : status === "uploading" ? "Archive incomplete upload" : "Archive"}</button>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 pl-[3.25rem] text-xs">
                    <div className="min-w-0">
                      <dt className="text-[var(--color-ink-faint)]">Category</dt>
                      <dd className="mt-0.5 truncate capitalize font-medium text-[var(--color-ink-soft)]">{document.category ?? "General"}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-ink-faint)]">Version</dt>
                      <dd className="tnum mt-0.5 font-semibold text-[var(--color-ink-soft)]">v{document.currentVersionNumber ?? 0}</dd>
                    </div>
                    <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[var(--color-ink-soft)]">
                      <dt className="sr-only">Modified</dt>
                      <dd className="flex min-w-0 items-center gap-1.5"><Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden /><span>{formatDate(document.updatedAt)}</span></dd>
                      <dt className="sr-only">Size</dt>
                      <dd className="tnum">{formatBytes(document.currentByteSize)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>

            <div className="scroll-thin hidden max-w-full overflow-x-auto sm:block" data-document-desktop-table>
              <table className="w-full min-w-[54rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-rule-strong)] text-xs font-semibold uppercase text-[var(--color-ink-faint)]">
                  <th className="px-3 py-2.5">Name</th>
                  <th className="px-3 py-2.5">Category</th>
                  <th className="px-3 py-2.5">Version</th>
                  <th className="px-3 py-2.5">Modified</th>
                  <th className="px-3 py-2.5">Size</th>
                  <th className="w-12 px-2 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id} className="border-b border-[var(--color-rule)] hover:bg-[var(--color-surface-muted)]">
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-3 text-left disabled:cursor-default"
                        disabled={!document.currentVersionId}
                        onClick={() => router.push(`/documents/pdf-editor?document=${document.id}`)}
                      >
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--color-primary-tint)] text-[var(--color-primary)]"><FileText className="h-4 w-4" aria-hidden /></span>
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-[var(--color-ink)]">{document.title}</span>
                          <span className="block truncate text-xs text-[var(--color-ink-faint)]">{document.currentFilename ?? "PDF upload pending"}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-3 capitalize text-[var(--color-ink-soft)]">{document.category ?? "General"}</td>
                    <td className="px-3 py-3"><span className="tnum rounded bg-[var(--color-surface-muted)] px-2 py-1 text-xs font-semibold">v{document.currentVersionNumber ?? 0}</span></td>
                    <td className="px-3 py-3 text-[var(--color-ink-soft)]"><span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" aria-hidden />{formatDate(document.updatedAt)}</span></td>
                    <td className="tnum px-3 py-3 text-[var(--color-ink-soft)]">{formatBytes(document.currentByteSize)}</td>
                    <td className="relative px-2 py-3 text-right">
                      <button type="button" className="btn btn-ghost btn-icon h-8 w-8" aria-label={`Actions for ${document.title}`} title="Document actions" onClick={() => setMenuId((current) => current === document.id ? null : document.id)}><MoreHorizontal className="h-4 w-4" aria-hidden /></button>
                      {menuId === document.id ? (
                        <div className="absolute right-2 top-11 z-20 w-40 rounded-md border border-[var(--color-rule-strong)] bg-white p-1 text-left shadow-lg">
                          {document.currentVersionId ? <button type="button" className="w-full rounded px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)]" onClick={() => router.push(`/documents/pdf-editor?document=${document.id}`)}>Open editor</button> : null}
                          {status === "archived" && !document.currentVersionId ? null : (
                            <button type="button" className="w-full rounded px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)]" onClick={() => void setArchived(document, status !== "archived")}>{status === "archived" ? "Restore to library" : status === "uploading" ? "Archive incomplete upload" : "Archive"}</button>
                          )}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
