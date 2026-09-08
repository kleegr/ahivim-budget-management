"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SourceBaseRecoveryReview } from "@/lib/sheets/base-recovery";
import { dec, formatMoney } from "@/lib/money";
import { friendlyActionError, importCorrectionsHref, transactionReviewHref } from "@/lib/nav/review-actions";

type Candidate = SourceBaseRecoveryReview["candidates"][number];
type History = SourceBaseRecoveryReview["history"][number];
type Amounts = { base: string; employeePayment: string; agencyAdditional: string };
type Selection = { action: "accept"; transactionIds: string[] } | { action: "undo"; acceptanceAuditId: string };
type Attempt = { signature: string; operationKey: string };
const PAGE_SIZE = 40;
const MAX_BATCH_SIZE = 1000;
const isSelectable = (row: Candidate) => row.eligible && !row.paid && row.previous !== null && row.next !== null;

/** A lost response must be retried with the same operation key and exact request. */
export function sourceBaseRecoveryAttempt(previous: Attempt | undefined, selection: Selection,
  sourceHash: string, reason: string, newKey: () => string = () => crypto.randomUUID()): Attempt {
  const signature = JSON.stringify([selection.action, sourceHash, reason.trim(),
    selection.action === "accept" ? [...selection.transactionIds].sort() : selection.acceptanceAuditId]);
  return previous?.signature === signature ? previous : { signature, operationKey: newKey() };
}

export function selectedSourceBaseTotals(candidates: Candidate[], side: "previous" | "next"): Amounts {
  const amounts = candidates.map(row => {
    if (!row[side]) throw new Error("Unknown amounts cannot be included in a correction total.");
    return row[side];
  });
  return {
    base: amounts.reduce((sum, value) => sum.plus(value.base), dec(0)).toFixed(4),
    employeePayment: amounts.reduce((sum, value) => sum.plus(value.employeePayment), dec(0)).toFixed(4),
    agencyAdditional: amounts.reduce((sum, value) => sum.plus(value.agencyAdditional), dec(0)).toFixed(4),
  };
}

export function sourceBaseHistoryHref(auditId: unknown, batchAuditId: unknown): string | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return typeof auditId === "string" && uuid.test(auditId)
    && typeof batchAuditId === "string" && uuid.test(batchAuditId)
    ? `/exceptions?kind=rate&sourceBaseReview=${batchAuditId}#source-base-history-${auditId}` : null;
}

function exactMoney(value: string | undefined) {
  if (value === undefined) return "Unknown";
  return dec(value).eq(dec(value).toDecimalPlaces(2)) ? formatMoney(value)
    : `${formatMoney(value)} (exact ${dec(value).toFixed(4)})`;
}

function ChangeSummary({ before, after }: { before: Amounts; after: Amounts }) {
  return <dl className="grid gap-3 text-sm sm:grid-cols-3">
    {([ ["Employee base", "base"], ["Employee payment allocation", "employeePayment"],
      ["Agency additional amount", "agencyAdditional"] ] as const).map(([label, key]) => <div key={key}>
      <dt className="text-[var(--color-ink-soft)]">{label}</dt>
      <dd className="mt-1 break-words tnum">{exactMoney(before[key])} → <strong>{exactMoney(after[key])}</strong></dd>
    </div>)}
  </dl>;
}

function SavedSourceRows({ items }: { items: History["items"] }) {
  const [page, setPage] = useState(0);
  return <details className="mt-3 text-sm">
    <summary className="cursor-pointer font-medium">Corrected records ({items.length.toLocaleString()})</summary>
    <ul className="mt-3 space-y-3">{items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(row => <li key={row.transactionId} className="rounded border border-[var(--color-rule)] p-3">
      <p className="mb-2 font-medium">{row.individual ?? "Individual unavailable"} · {row.employee ?? "Employee unavailable"}</p>
      <ChangeSummary before={row.previous} after={row.next} />
      <p className="mt-2">Amount mismatch: {row.previous.mismatch ? "Flagged" : "Clear"} → {row.next.mismatch ? "Flagged" : "Clear"}</p>
      <div className="mt-2 flex flex-wrap gap-3">
        <Link prefetch={false} className="text-[var(--color-primary)] underline" href={transactionReviewHref(row.transactionId)}>Transaction</Link>
        {row.sourceFileId ? <Link prefetch={false} className="text-[var(--color-primary)] underline" href={importCorrectionsHref(row.sourceFileId, row.importRowId)}>Original source row {row.sourceRowNumber ?? "unavailable"}</Link>
          : <span>Original source record unavailable</span>}
      </div>
    </li>)}</ul>
    {items.length > PAGE_SIZE ? <div className="mt-3 flex flex-wrap gap-3">
      <span>Page {page + 1} of {Math.ceil(items.length / PAGE_SIZE)}</span>
      <button type="button" className="btn btn-sm btn-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous saved rows</button>
      <button type="button" className="btn btn-sm btn-secondary" disabled={(page + 1) * PAGE_SIZE >= items.length} onClick={() => setPage(page + 1)}>Next saved rows</button>
    </div> : null}
  </details>;
}

export default function SourceBaseRecoveryPanel({ review }: { review: SourceBaseRecoveryReview }) {
  const reasonId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const attempts = useRef<Attempt | undefined>(undefined);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const eligible = useMemo(() => review.candidates.filter(isSelectable), [review.candidates]);
  const batchEligible = eligible.slice(0, MAX_BATCH_SIZE);
  const selected = useMemo(() => eligible.filter(row => selectedIds.has(row.transactionId)), [eligible, selectedIds]);
  const selectedTotals = useMemo(() => ({ previous: selectedSourceBaseTotals(selected, "previous"),
    next: selectedSourceBaseTotals(selected, "next") }), [selected]);
  const filtered = review.candidates.filter(row => !query.trim()
    || `${row.individual} ${row.employee} ${row.sourceRowNumber}`.toLowerCase().includes(query.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const historySelection = selection?.action === "undo"
    ? review.history.find(row => row.acceptanceAuditId === selection.acceptanceAuditId) : undefined;
  const selectedGroups = selected.filter(row => row.groupBudgetBasis).length;

  useEffect(() => {
    if (selection) formRef.current?.scrollIntoView({ block: "center" });
  }, [selection]);

  function choose(next: Selection) {
    setSelection(next);
    setReason("");
    setNotice(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selection || !review.sourceHash || !reason.trim() || busy) return;
    const attempt = sourceBaseRecoveryAttempt(attempts.current, selection, review.sourceHash, reason);
    attempts.current = attempt;
    setBusy(true);
    setNotice(null);
    let navigating = false;
    try {
      const response = await fetch("/api/sync/source-base-recovery", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...selection, sourceHash: review.sourceHash,
          reason: reason.trim(), operationKey: attempt.operationKey }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) {
        setNotice({ error: true, text: friendlyActionError(body?.error,
          "Could not confirm the result. Keep the same selection and reason when retrying.") });
        return;
      }
      const destination = sourceBaseHistoryHref(body.data?.acceptanceAuditId, body.data?.batchAuditId);
      if (!destination) {
        setNotice({ error: true, text: "Could not confirm the saved history. Keep the same selection and reason when retrying." });
        return;
      }
      navigating = true;
      window.location.assign(destination);
    } catch {
      setNotice({ error: true, text: "Could not confirm the result. Keep the same selection and reason when retrying." });
    } finally {
      if (!navigating) setBusy(false);
    }
  }

  function historyCard(entry: History) {
    return <li key={entry.acceptanceAuditId} id={`source-base-history-${entry.acceptanceAuditId}`}
      className="scroll-mt-24 rounded-lg border border-[var(--color-rule)] p-3 target:ring-2 target:ring-[var(--color-primary)]">
      <p className="font-medium">{entry.transactionCount.toLocaleString()} corrections · {entry.reversedAt ? "Reversed" : "Saved"}</p>
      <p className="mt-1 break-words text-sm">{entry.reason}</p>
      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">Saved {entry.acceptedAt}</p>
      <details className="mt-2 text-sm"><summary className="cursor-pointer font-medium">Saved amount changes</summary>
        <div className="mt-3"><ChangeSummary before={entry.previousTotals} after={entry.nextTotals} /></div>
        {entry.groupBudgetBasisCount > 0 ? <p className="mt-2">{entry.groupBudgetBasisCount} records also affect historical group-hour calculations.</p> : null}
      </details>
      <SavedSourceRows items={entry.items} />
      <p className="mt-2 text-xs text-[var(--color-ink-soft)]">Original import warnings remain as history. Rate decisions are reviewed separately.</p>
      {entry.reversedAt ? <p className="mt-1 text-xs">Reversed {entry.reversedAt}</p>
        : <div className="mt-2">
          <button type="button" className="btn btn-sm btn-secondary" disabled={busy || !entry.canUndo || !review.sourceHash}
            onClick={() => choose({ action: "undo", acceptanceAuditId: entry.acceptanceAuditId })}>Review reversal</button>
          {!entry.canUndo && entry.undoReviewReason ? <p className="mt-2 text-sm">{entry.undoReviewReason}</p> : null}
        </div>}
    </li>;
  }

  return <section className="card min-w-0 overflow-hidden" aria-labelledby="source-base-title" id="source-base-recovery">
    <header className="border-b border-[var(--color-rule)] px-5 py-4">
      <h2 id="source-base-title" className="display text-base font-semibold">Employee base corrections</h2>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Compare historical calculations with the original and current source. Saving records the previous amounts and a reason so the correction can be reversed.</p>
    </header>
    <div className="space-y-4 p-5">
      {!review.sourceHash ? <p role="alert" className="text-sm">The current source could not be verified. {review.reviewReason ?? "Corrections are unavailable; reload this review when the source is available."}</p> : null}
      <p className="text-sm"><strong>{eligible.length.toLocaleString()}</strong> eligible · <strong>{(review.candidates.length - eligible.length).toLocaleString()}</strong> need further review</p>
      <p className="text-sm text-[var(--color-ink-soft)]">Paid activity and financial history that needs review remain on hold. Approving a source rate is a separate decision.</p>
      {notice ? <p role={notice.error ? "alert" : "status"} className="text-sm">{notice.text}</p> : null}
      {review.candidates.length > 0 ? <>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" checked={batchEligible.length > 0 && batchEligible.every(row => selectedIds.has(row.transactionId))}
              disabled={busy || !!selection || !review.sourceHash || eligible.length === 0}
              onChange={event => setSelectedIds(new Set(event.target.checked ? batchEligible.map(row => row.transactionId) : []))} />
            Select {eligible.length > MAX_BATCH_SIZE ? "first" : "all"} {batchEligible.length.toLocaleString()} eligible corrections
          </label>
          <button type="button" className="btn btn-primary" disabled={busy || !!selection || !review.sourceHash || selected.length === 0 || selected.length > MAX_BATCH_SIZE}
            onClick={() => choose({ action: "accept", transactionIds: selected.map(row => row.transactionId) })}>
            Review {selected.length.toLocaleString()} selected corrections
          </button>
        </div>
        <label className="block text-sm">Find a person or source row
          <input type="search" className="input mt-1 w-full" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
        </label>
        <div className="overflow-x-auto rounded-lg border border-[var(--color-rule)]">
          <table className="w-full text-left text-sm" aria-label="Historical Employee base corrections">
            <thead><tr className="border-b border-[var(--color-rule)]">
              { ["Select", "Person", "Employee base", "Review", "Source"] .map(title => <th key={title} className="px-3 py-2 font-medium">{title}</th>) }
            </tr></thead>
            <tbody>{visible.map(row => <tr key={row.transactionId} className="border-b border-[var(--color-rule)] last:border-0">
              <td className="px-3 py-3"><input type="checkbox" aria-label={`Select correction for ${row.individual}, source row ${row.sourceRowNumber}`}
                checked={selectedIds.has(row.transactionId)} disabled={busy || !!selection || !isSelectable(row) || !review.sourceHash
                  || (selected.length >= MAX_BATCH_SIZE && !selectedIds.has(row.transactionId))}
                onChange={event => setSelectedIds(current => { const next = new Set(current); if (event.target.checked) next.add(row.transactionId); else next.delete(row.transactionId); return next; })} /></td>
              <td className="min-w-40 px-3 py-3"><p>{row.individual ?? "Individual unavailable"}</p><p className="text-xs text-[var(--color-ink-soft)]">{row.employee ?? "Employee unavailable"}</p></td>
              <td className="min-w-48 px-3 py-3 tnum">{exactMoney(row.previous?.base)} → <strong>{exactMoney(row.next?.base)}</strong>
                <details className="mt-1 text-xs"><summary className="cursor-pointer">Related amounts</summary>
                  <p className="mt-1">Employee payment allocation: {exactMoney(row.previous?.employeePayment)} → {exactMoney(row.next?.employeePayment)}</p>
                  <p>Agency additional: {exactMoney(row.previous?.agencyAdditional)} → {exactMoney(row.next?.agencyAdditional)}</p>
                  <p>Amount mismatch: {row.previous === null ? "Unknown" : row.previous.mismatch ? "Flagged" : "Clear"} → {row.next === null ? "Unknown" : row.next.mismatch ? "Flagged" : "Clear"}</p>
                </details></td>
              <td className="min-w-48 px-3 py-3">{isSelectable(row) ? "Eligible" : row.reviewReason ?? "Source review required"}
                {row.groupBudgetBasis ? <p className="mt-1 text-xs">Group-hour history uses Employee base.</p> : null}</td>
              <td className="min-w-32 px-3 py-3"><div className="flex flex-col gap-2">
                <Link prefetch={false} className="text-[var(--color-primary)] underline" href={transactionReviewHref(row.transactionId)}>Transaction</Link>
                {row.sourceFileId ? <Link prefetch={false} className="text-[var(--color-primary)] underline" href={importCorrectionsHref(row.sourceFileId, row.importRowId)}>Source row {row.sourceRowNumber ?? "unavailable"}</Link>
                  : <span>Source record unavailable</span>}
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>{filtered.length.toLocaleString()} rows · page {currentPage + 1} of {Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}</span>
          <button className="btn btn-sm btn-secondary" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous rows</button>
          <button className="btn btn-sm btn-secondary" type="button" disabled={(currentPage + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next rows</button>
        </div>
      </> : <p className="text-sm">No historical Employee base differences are awaiting this correction.</p>}
      {selection ? <form ref={formRef} onSubmit={submit} className="space-y-4 rounded-lg border border-[var(--color-rule)] p-4" aria-label="Review Employee base correction">
        <h3 className="font-semibold">{selection.action === "accept" ? `Save ${selection.transactionIds.length.toLocaleString()} corrections` : `Reverse ${historySelection?.transactionCount.toLocaleString() ?? "saved"} corrections`}</h3>
        {selection.action === "accept" ? <ChangeSummary before={selectedTotals.previous} after={selectedTotals.next} />
          : historySelection ? <ChangeSummary before={historySelection.nextTotals} after={historySelection.previousTotals} /> : null}
        {(selection.action === "accept" ? selectedGroups : historySelection?.groupBudgetBasisCount ?? 0) > 0
          ? <p className="text-sm">Group-hour history is calculated from Employee base. This correction also changes the affected historical usage and remaining hours; source service hours and authorization amounts are preserved.</p> : null}
        <p className="text-sm">Each corrected record keeps its source evidence and an audit of the prior amounts. Payment and rate approvals remain separate.</p>
        <label htmlFor={reasonId} className="block text-sm font-medium">{selection.action === "accept" ? "Reason for this correction" : "Reason for this reversal"}</label>
        <textarea id={reasonId} className="input w-full min-w-0 resize-y" value={reason} rows={3} required maxLength={2000}
          disabled={busy} onChange={event => setReason(event.target.value)} />
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" type="submit" disabled={busy || !reason.trim() || !review.sourceHash}>
            {busy ? "Saving…" : selection.action === "accept" ? "Save corrections" : "Record reversal"}
          </button>
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => setSelection(null)}>Cancel</button>
        </div>
      </form> : null}
      {review.history.length > 0 ? <div className="border-t border-[var(--color-rule)] pt-4">
        <h3 className="font-semibold">Correction history</h3>
        <ul className="mt-3 space-y-3">{review.history.map(historyCard)}</ul>
      </div> : null}
    </div>
  </section>;
}
