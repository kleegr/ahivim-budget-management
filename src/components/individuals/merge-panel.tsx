"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/money";

type Candidate = {
  id: string;
  name: string;
  txCount: number;
  hasPlan: boolean;
  billedAgency: string;
  similarity: number;
};

/**
 * Connect a budgeted individual to transactions that came in under a different
 * name. Imports mint a separate record for an unrecognized spelling, so "the
 * same person under another name" is a second individual row carrying the
 * billing. Picking it here folds that record in: its transactions repoint to
 * this person, the old spelling is remembered so future imports match, and the
 * folded-in row is archived (reversible, never deleted).
 *
 * Presented as a small button that opens a lightweight modal — it's an occasional
 * housekeeping action, not a section that deserves a whole card on the profile.
 */
export default function MergePanel({ individualId, individualName }: { individualId: string; individualName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (query: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/individuals/${individualId}/merge?q=${encodeURIComponent(query)}`);
        const j = await res.json();
        if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not load candidates.");
        setCandidates(j.data as Candidate[]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load candidates.");
      } finally {
        setLoading(false);
      }
    },
    [individualId],
  );

  useEffect(() => {
    if (!open) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(q), 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [open, q, load]);

  // Close on Escape while the modal is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const merge = async (mergeId: string) => {
    setBusyId(mergeId);
    setError(null);
    try {
      const res = await fetch(`/api/individuals/${individualId}/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mergeId }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not connect the records.");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect the records.");
      setBusyId(null);
      setConfirmId(null);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn btn-sm btn-secondary" title="Connect transactions billed under another name">
        Connect records
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-20"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`Connect records for ${individualName}`}
        >
          <div className="card w-full max-w-lg p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-[var(--color-ink)]">Connect records</p>
                <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
                  Find the record holding <span className="font-medium text-[var(--color-ink)]">{individualName}</span>&rsquo;s transactions under a different name, and fold it in.
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="text-sm text-[var(--color-ink-faint)] hover:underline">Close</button>
            </div>

            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search a name or spelling…"
              className="input w-full"
              aria-label="Search individuals to connect"
              autoFocus
            />

            {error ? <p className="mt-2 text-sm text-[var(--color-danger)]">{error}</p> : null}

            <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-[var(--color-rule)]">
              {loading && candidates.length === 0 ? (
                <p className="px-3 py-4 text-sm text-[var(--color-ink-faint)]">Looking…</p>
              ) : candidates.length === 0 ? (
                <p className="px-3 py-4 text-sm text-[var(--color-ink-faint)]">No other records{q ? " match that search" : " to connect"}.</p>
              ) : (
                <ul className="divide-y divide-[var(--color-rule)]">
                  {candidates.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-[var(--color-ink)]">
                          {c.name}
                          {c.similarity >= 0.6 ? <span className="ml-2 rounded bg-[var(--color-warn-soft,#fff4e5)] px-1.5 py-0.5 text-[0.7rem] font-medium text-[var(--color-warn)]">likely match</span> : null}
                          {c.hasPlan ? <span className="ml-2 text-[0.7rem] text-[var(--color-ink-faint)]">has its own budget</span> : null}
                        </p>
                        <p className="text-xs text-[var(--color-ink-faint)]">
                          {c.txCount.toLocaleString()} {c.txCount === 1 ? "transaction" : "transactions"} · {formatMoney(c.billedAgency)} billed
                        </p>
                      </div>
                      {confirmId === c.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-[var(--color-ink-soft)]">Fold in?</span>
                          <button type="button" disabled={busyId === c.id} onClick={() => merge(c.id)} className="btn btn-sm btn-primary">
                            {busyId === c.id ? "Connecting…" : "Confirm"}
                          </button>
                          <button type="button" disabled={busyId === c.id} onClick={() => setConfirmId(null)} className="btn btn-sm btn-ghost">Cancel</button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => setConfirmId(c.id)} className="btn btn-sm btn-secondary">Connect</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
              Connecting moves the other record&rsquo;s transactions onto this person and remembers the spelling for next time. The folded-in record is archived, not deleted, so it can be undone.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
