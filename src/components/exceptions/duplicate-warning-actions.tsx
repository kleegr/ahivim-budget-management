"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ButtonLink } from "@/components/ui";
import { importCorrectionsHref, transactionReviewHref } from "@/lib/nav/review-actions";

export default function DuplicateWarningActions({
  warningId,
  transactionId,
  sourceFileId,
  importRowId,
}: {
  warningId: string;
  transactionId: string | null;
  sourceFileId: string;
  importRowId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markReviewed() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/import-warnings/${warningId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "mark_reviewed",
          reason: "Committed duplicate candidate reviewed from the Exceptions screen",
        }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || body.ok === false) {
        setError(body.error ?? "This warning could not be marked reviewed.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-40 flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {transactionId ? (
          <ButtonLink href={transactionReviewHref(transactionId)} variant="primary">Inspect transaction</ButtonLink>
        ) : null}
        <ButtonLink href={importCorrectionsHref(sourceFileId, importRowId)} variant="secondary">Source history</ButtonLink>
        <button
          type="button"
          onClick={markReviewed}
          disabled={busy || !transactionId}
          className="rounded border border-[var(--color-rule)] bg-white px-2.5 py-1.5 text-xs font-medium text-[var(--color-ink)] disabled:opacity-50"
        >
          {busy ? "Saving..." : "Mark reviewed"}
        </button>
      </div>
      {!transactionId ? <p role="alert" className="text-xs text-[var(--color-pace-over)]">Committed transaction missing.</p> : null}
      {error ? <p role="alert" className="text-xs text-[var(--color-pace-over)]">{error}</p> : null}
    </div>
  );
}
