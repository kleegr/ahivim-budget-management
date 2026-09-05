"use client";

import Link from "next/link";
import { Download, ExternalLink, FileText, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface StoredDocument {
  id: string;
  title: string;
  description: string | null;
  currentVersionId: string | null;
  currentFilename: string | null;
}

interface StoredDocumentVersion {
  id: string;
  versionNumber: number;
  versionKind: "original" | "saved" | "restored";
  changeSummary: string | null;
  filename: string;
  createdAt: string;
}

interface StoredDocumentDetail {
  document: StoredDocument;
  versions: StoredDocumentVersion[];
}

export default function DocumentViewerWorkspace({ documentId }: { documentId: string | null }) {
  const [detail, setDetail] = useState<StoredDocumentDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(documentId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!documentId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch(`/api/documents/${documentId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as {
          ok?: boolean;
          data?: StoredDocumentDetail;
          error?: string;
        };
        if (!response.ok || !body.ok || !body.data) {
          throw new Error(body.error || "That document could not be opened.");
        }
        setDetail(body.data);
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "That document could not be opened.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [documentId]);

  const currentVersion = useMemo(() => {
    if (!detail) return null;
    return detail.versions.find((version) => version.id === detail.document.currentVersionId)
      ?? detail.versions[0]
      ?? null;
  }, [detail]);

  if (!documentId) {
    return (
      <section className="mx-auto max-w-2xl rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] p-6">
        <p className="eyebrow">Documents</p>
        <h1 className="display mt-1 text-2xl">Choose a saved document</h1>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          This account has view-only access. Open a saved PDF from the document library to view or download it.
        </p>
        <Link href="/documents" className="btn btn-primary mt-5">Back to documents</Link>
      </section>
    );
  }

  if (loading) {
    return <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-[var(--color-ink-soft)]"><LoaderCircle className="h-5 w-5 animate-spin" aria-hidden /> Opening document</div>;
  }

  if (error || !detail || !currentVersion) {
    return (
      <section className="mx-auto max-w-2xl rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] p-6">
        <p role="alert" className="text-sm text-[var(--color-danger)]">{error ?? "This document has no saved PDF version."}</p>
        <Link href="/documents" className="btn btn-secondary mt-5">Back to documents</Link>
      </section>
    );
  }

  const fileUrl = `/api/documents/${detail.document.id}/versions/${currentVersion.id}/file`;
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-rule)] pb-4">
        <div>
          <div className="flex items-center gap-2">
            <p className="eyebrow">Saved document</p>
            <span className="badge bg-[var(--color-surface-muted)] text-[var(--color-ink-soft)]">View only</span>
          </div>
          <h1 className="display mt-1 text-2xl">{detail.document.title}</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{detail.document.description || detail.document.currentFilename || "Saved PDF"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/documents" className="btn btn-secondary">Library</Link>
          <a href={fileUrl} target="_blank" rel="noreferrer" className="btn btn-secondary"><ExternalLink className="h-4 w-4" aria-hidden /> Open PDF</a>
          <a href={`${fileUrl}?download=1`} className="btn btn-primary"><Download className="h-4 w-4" aria-hidden /> Download</a>
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="min-h-[70vh] overflow-hidden rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface-muted)]">
          <iframe title={`${detail.document.title} PDF`} src={fileUrl} className="h-[75vh] w-full bg-white" />
        </section>
        <aside className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] p-4">
          <div className="flex items-center gap-2"><FileText className="h-4 w-4 text-[var(--color-primary)]" aria-hidden /><h2 className="font-semibold">Version history</h2></div>
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Earlier versions remain available to view or download. This account cannot restore or change them.</p>
          <ul className="mt-3 divide-y divide-[var(--color-rule)]">
            {detail.versions.map((version) => {
              const versionUrl = `/api/documents/${detail.document.id}/versions/${version.id}/file`;
              return (
                <li key={version.id} className="py-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">Version {version.versionNumber}</p>
                      <p className="text-xs text-[var(--color-ink-faint)]">{version.changeSummary || version.versionKind}</p>
                    </div>
                    {version.id === currentVersion.id ? <span className="badge">Current</span> : null}
                  </div>
                  <div className="mt-2 flex gap-3 text-xs font-semibold text-[var(--color-primary)]">
                    <a href={versionUrl} target="_blank" rel="noreferrer">Open</a>
                    <a href={`${versionUrl}?download=1`}>Download</a>
                  </div>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
    </div>
  );
}
