"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ButtonLink } from "@/components/ui";
import { importCorrectionsHref, transactionReviewHref } from "@/lib/nav/review-actions";

export default function RateExceptionActions({
  exceptionId,
  transactionId,
  sourceFileId,
  importRowId,
}: {
  exceptionId: string;
  transactionId: string | null;
  sourceFileId: string | null;
  importRowId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (!window.confirm("Accept this imported rate as legitimate? The transaction amount will not change.")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/rate-exceptions/${exceptionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "accept",
          reason: "Confirmed as a legitimate imported rate from the Exceptions screen",
        }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || body.ok === false) {
        setError(body.error ?? "The rate could not be accepted.");
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
        <button
          type="button"
          onClick={accept}
          disabled={busy}
          className="rounded bg-[var(--color-primary)] px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {busy ? "Accepting…" : "Accept imported rate"}
        </button>
        {transactionId ? (
          <ButtonLink href={transactionReviewHref(transactionId)} variant="secondary">Transaction</ButtonLink>
        ) : null}
        {sourceFileId && importRowId ? (
          <ButtonLink href={importCorrectionsHref(sourceFileId, importRowId)} variant="secondary">Source history</ButtonLink>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-xs text-[var(--color-pace-over)]">{error}</p> : null}
    </div>
  );
}
