"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import type { SyncConflictRow } from "@/lib/sheets/queries";
import type { SourceNetRecoveryHistory } from "@/lib/sheets/net-recovery-queries";
import { dec, formatMoney } from "@/lib/money";
import { friendlyActionError, transactionReviewHref } from "@/lib/nav/review-actions";

interface Props {
  conflicts: SyncConflictRow[];
  history: SourceNetRecoveryHistory[];
}

type RecoveryAction = "accept" | "undo";
interface Selection {
  action: RecoveryAction;
  conflictId: string;
  acceptanceAuditId?: string;
}
interface RecoveryAttempt {
  signature: string;
  operationKey: string;
}

function numericNet(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  try {
    const amount = dec(text);
    return amount.isFinite() && !amount.isNegative() && amount.lt("10000000000")
      && amount.decimalPlaces() <= 4 ? amount.toFixed(4) : null;
  } catch {
    return null;
  }
}

/** Presentation eligibility only; the server rechecks the complete source. */
export function recoverableSourceNet(conflict: SyncConflictRow): string | null {
  if (conflict.type !== "changed" || conflict.status !== "open" || !conflict.transactionId
    || conflict.previous?.sourceEvidenceConflict !== "routing_or_net"
    || conflict.previous.totalNetPay !== null) return null;
  const incoming = conflict.incoming;
  if (!incoming) return null;
  const net = numericNet(incoming.totalNetPay);
  if (net === null) return null;
  if (incoming.sourceEvidenceVariants !== undefined) {
    const variants = incoming.sourceEvidenceVariants;
    if (!Array.isArray(variants) || variants.length !== 1) return null;
    const variant = variants[0];
    if (!variant || typeof variant !== "object") return null;
    const variantNet = numericNet((variant as Record<string, unknown>).totalNetPay);
    if (variantNet === null || !dec(variantNet).eq(net)) return null;
  }
  return net;
}

/** Keep the same retry key after an uncertain response to the same request. */
export function sourceNetRecoveryAttempt(
  previous: RecoveryAttempt | undefined,
  selection: Selection,
  reason: string,
  newKey: () => string = () => crypto.randomUUID(),
): RecoveryAttempt {
  const signature = JSON.stringify([selection.action, selection.conflictId,
    selection.acceptanceAuditId ?? null, reason.trim()]);
  return previous?.signature === signature ? previous : { signature, operationKey: newKey() };
}

/** Reload the exact saved history after the server confirms its audit records. */
export function sourceNetRecoveryHistoryHref(auditId: unknown, acceptanceAuditId: unknown): string | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof auditId !== "string" || typeof acceptanceAuditId !== "string"
    || !uuid.test(auditId) || !uuid.test(acceptanceAuditId)) return null;
  return `/sync?sourceNetReview=${auditId}#source-net-history-${acceptanceAuditId}`;
}

function dateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short",
  }).format(parsed);
}

function displayNet(value: string): string {
  const formatted = formatMoney(value);
  return dec(value).eq(dec(value).toDecimalPlaces(2)) ? formatted : `${formatted} (exact ${dec(value).toFixed(4)})`;
}

export default function NetRecoveryPanel({ conflicts, history }: Props) {
  const reasonId = useId();
  const attempts = useRef(new Map<string, RecoveryAttempt>());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const recoverable = conflicts.flatMap(conflict => {
    const net = recoverableSourceNet(conflict);
    return net === null ? [] : [{ conflict, net }];
  });
  if (recoverable.length === 0 && history.length === 0) return null;

  function choose(next: Selection) {
    setSelection(next);
    setReason("");
    setNotice(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selection || !reason.trim() || busy) return;
    const scope = `${selection.action}:${selection.conflictId}:${selection.acceptanceAuditId ?? ""}`;
    const attempt = sourceNetRecoveryAttempt(attempts.current.get(scope), selection, reason);
    attempts.current.set(scope, attempt);
    setBusy(true);
    setNotice(null);
    let navigating = false;
    try {
      const response = await fetch(`/api/sync/conflicts/${encodeURIComponent(selection.conflictId)}/net-recovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: selection.action, acceptanceAuditId: selection.acceptanceAuditId,
          reason: reason.trim(), operationKey: attempt.operationKey }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) {
        setNotice({ error: true, text: friendlyActionError(body?.error, "Could not confirm the result. Retry with the same reason to check that attempt.") });
        return;
      }
      const historyHref = sourceNetRecoveryHistoryHref(body.data?.auditId, body.data?.acceptanceAuditId);
      if (!historyHref) {
        setNotice({ error: true, text: "Could not confirm the result. Retry with the same reason to check that attempt." });
        return;
      }
      setNotice({ error: false, text: selection.action === "accept"
        ? "Source NET saved. Check confirmation is separate."
        : "Source NET entry undone. The previous unknown NET is restored." });
      window.location.assign(historyHref);
      navigating = true;
    } catch {
      setNotice({ error: true, text: "Could not confirm the result. Retry with the same reason to check that attempt." });
    } finally {
      if (!navigating) setBusy(false);
    }
  }

  function actionForm(target: Selection) {
    if (!selection || selection.action !== target.action || selection.conflictId !== target.conflictId
      || selection.acceptanceAuditId !== target.acceptanceAuditId) return null;
    return (
      <form className="mt-3 space-y-2" onSubmit={submit}>
        <label className="block text-sm font-medium" htmlFor={reasonId}>
          {selection.action === "accept" ? "Reason for using this source NET" : "Reason for undoing this entry"}
        </label>
        <textarea id={reasonId} value={reason} onChange={event => setReason(event.target.value)}
          required maxLength={2000} rows={2} disabled={busy}
          className="input w-full min-w-0 resize-y" />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary" disabled={busy || !reason.trim()}>
            {busy ? "Saving…" : selection.action === "accept" ? "Save source NET" : "Undo source NET entry"}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setSelection(null)}>Cancel</button>
        </div>
      </form>
    );
  }

  return (
    <section id="source-net-recovery" className="card min-w-0 overflow-hidden" aria-labelledby="source-net-recovery-title">
      <header className="border-b border-[var(--color-rule)] px-5 py-3.5">
        <h2 id="source-net-recovery-title" className="display text-[0.95rem] font-semibold">Source NET review</h2>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Use a recovered Sheet NET for a transaction whose NET is unknown. Checks still need confirmation.</p>
      </header>
      {notice ? <p role={notice.error ? "alert" : "status"} className="px-5 pt-4 text-sm" style={{ color: notice.error ? "var(--color-danger)" : "var(--color-success)" }}>{notice.text}</p> : null}
      {recoverable.length > 0 ? <ul className="space-y-3 p-5">
        {recoverable.map(({ conflict, net }) => <li key={conflict.id} className="min-w-0 rounded-lg border border-[var(--color-rule)] p-3">
          <p className="break-words text-sm font-medium">{conflict.individualName ?? "Individual unavailable"} · {conflict.employeeName ?? "Employee unavailable"}</p>
          <p className="mt-1 text-sm">Recorded NET: Unknown · Source NET: <strong>{displayNet(net)}</strong></p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Link className="text-sm font-semibold text-[var(--color-primary)] underline" href={transactionReviewHref(conflict.transactionId!)}>Open transaction</Link>
            <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => choose({ action: "accept", conflictId: conflict.id })}>Use source NET</button>
          </div>
          {actionForm({ action: "accept", conflictId: conflict.id })}
        </li>)}
      </ul> : null}
      {history.length > 0 ? <div className="border-t border-[var(--color-rule)] p-5">
        <h3 className="text-sm font-semibold">Source NET history</h3>
        <ul className="mt-3 space-y-3">
          {history.map(entry => <li key={entry.acceptanceAuditId} id={`source-net-history-${entry.acceptanceAuditId}`} className="min-w-0 scroll-mt-[calc(var(--impersonation-bar-height)+5rem)] rounded-lg border border-[var(--color-rule)] p-3">
            <p className="text-sm font-medium">{displayNet(entry.acceptedNet)} · {entry.reversedAt ? "Undone" : "Saved"}</p>
            <p className="mt-1 break-words text-xs text-[var(--color-ink-soft)]">{dateTime(entry.acceptedAt)}{entry.acceptedBy ? ` · ${entry.acceptedBy}` : ""}</p>
            {entry.reason ? <p className="mt-1 break-words text-sm">{entry.reason}</p> : null}
            {entry.reversedAt ? <p className="mt-1 text-xs text-[var(--color-ink-soft)]">Undone {dateTime(entry.reversedAt)}</p> : null}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Link className="text-sm font-semibold text-[var(--color-primary)] underline" href={transactionReviewHref(entry.transactionId)}>Open transaction</Link>
              {!entry.reversedAt ? <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => choose({ action: "undo", conflictId: entry.conflictId, acceptanceAuditId: entry.acceptanceAuditId })}>Undo</button> : null}
            </div>
            {actionForm({ action: "undo", conflictId: entry.conflictId, acceptanceAuditId: entry.acceptanceAuditId })}
          </li>)}
        </ul>
      </div> : null}
    </section>
  );
}
