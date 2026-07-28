"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface CommitResponse {
  ok?: boolean;
  error?: string;
  note?: string;
  alreadyCommitted?: boolean;
  counts?: Record<string, number>;
  rolledBack?: boolean;
}

/** Commit or discard a staged import. Both actions ask before acting. */
export default function CommitPanel({
  fileId,
  validRows,
  heldRows,
}: {
  fileId: string;
  validRows: number;
  heldRows: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"commit" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CommitResponse | null>(null);

  async function onCommit() {
    if (!window.confirm(`Commit ${validRows.toLocaleString()} valid rows to the ledger? Rows held for review are not imported.`)) return;
    setBusy("commit");
    setError(null);
    try {
      const response = await fetch(`/api/imports/${fileId}/commit`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as CommitResponse;
      if (!response.ok || !body.ok) {
        setError(body.error ?? "The commit failed.");
        setBusy(null);
        return;
      }
      setResult(body);
      setBusy(null);
      router.refresh();
    } catch {
      setError("Could not reach the server. Reload this page to see whether the commit completed.");
      setBusy(null);
    }
  }

  async function onDiscard() {
    if (!window.confirm("Discard this staged upload? The file and its parsed rows are removed. Nothing committed is affected.")) return;
    setBusy("discard");
    setError(null);
    try {
      const response = await fetch(`/api/imports/${fileId}`, { method: "DELETE" });
      const body = (await response.json().catch(() => ({}))) as CommitResponse;
      if (!response.ok || !body.ok) {
        setError(body.error ?? "The upload could not be discarded.");
        setBusy(null);
        return;
      }
      router.push("/imports");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-5 py-4">
      <h2 className="display text-base font-medium">Commit this import</h2>
      <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-soft)]">
        {validRows.toLocaleString()} valid rows will become payroll transactions inside one database
        transaction. {heldRows.toLocaleString()} rows are held for review and will be stored with
        their source values but will not become transactions. If any part of the write fails, the
        whole thing is rolled back and nothing is committed.
      </p>

      {error ? (
        <p role="alert" className="mt-3 rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">
          {error}
        </p>
      ) : null}

      {result ? (
        <div role="status" className="mt-3 rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm text-[var(--color-primary)]">
          <p className="font-medium">{result.alreadyCommitted ? "Already committed" : "Committed"}</p>
          <p className="mt-1">{result.note}</p>
          {result.counts ? (
            <p className="tnum mt-1">
              {result.counts.transactions?.toLocaleString()} transactions ·{" "}
              {result.counts.serviceSessions?.toLocaleString()} sessions ·{" "}
              {result.counts.serviceAllocations?.toLocaleString()} allocations ·{" "}
              {result.counts.reviewRows?.toLocaleString()} held for review
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onCommit}
          disabled={busy !== null || result !== null}
          className="rounded bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy === "commit" ? "Committing…" : `Commit ${validRows.toLocaleString()} rows`}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={busy !== null || result !== null}
          className="rounded border border-[var(--color-rule-strong)] px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {busy === "discard" ? "Discarding…" : "Discard upload"}
        </button>
      </div>
    </section>
  );
}
