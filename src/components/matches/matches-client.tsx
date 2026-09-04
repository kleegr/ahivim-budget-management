"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export interface MatchReview {
  id: string;
  keepId: string;
  keepName: string;
  keepTransactions: number;
  keepStrategies: number;
  mergeId: string;
  mergeName: string;
  mergeTransactions: number;
  mergeStrategies: number;
  score: string;
  reason: string | null;
}

function Person({ name, id, tx, strat }: { name: string; id: string; tx: number; strat: number }) {
  return (
    <div className="min-w-0">
      <Link href={`/individuals/${id}`} className="block truncate font-medium text-[var(--color-ink)] hover:underline">
        {name}
      </Link>
      <p className="mt-0.5 text-xs text-[var(--color-text-soft)]">
        {tx.toLocaleString()} transaction{tx === 1 ? "" : "s"} · {strat} strateg{strat === 1 ? "y" : "ies"}
      </p>
    </div>
  );
}

export default function MatchesClient({ reviews, canManage }: { reviews: MatchReview[]; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [swapped, setSwapped] = useState<Record<string, boolean>>({});

  const scan = async () => {
    setBusy("scan");
    setNotice(null);
    try {
      const res = await fetch("/api/matches/scan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Scan failed.");
      setNotice(`Scan complete — ${j.data.queued} candidate${j.data.queued === 1 ? "" : "s"} sent to review. No records were merged.`);
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Scan failed.");
    } finally {
      setBusy(null);
    }
  };

  const decide = async (r: MatchReview, action: "confirm" | "reject") => {
    setBusy(r.id);
    setNotice(null);
    try {
      const keep = swapped[r.id] ? r.mergeId : r.keepId;
      const merge = swapped[r.id] ? r.keepId : r.mergeId;
      const res = await fetch(`/api/matches/${r.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, keepId: keep, mergeId: merge }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Action failed.");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-text-soft)]">
          {reviews.length === 0 ? "No uncertain matches are waiting." : `${reviews.length} possible ${reviews.length === 1 ? "match" : "matches"} to review.`}
        </p>
        {canManage && (
          <button type="button" onClick={scan} disabled={busy === "scan"} className="btn btn-sm btn-primary">
            {busy === "scan" ? "Scanning…" : "Scan for matches"}
          </button>
        )}
      </div>

      {notice && <div className="card px-4 py-2.5 text-sm">{notice}</div>}

      {reviews.length === 0 ? (
        <div className="card px-5 py-12 text-center">
          <p className="display text-[0.95rem] font-semibold">Everything is connected</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-[var(--color-text-soft)]">
            Similar names are suggestions only. Every possible match waits here for a person to decide.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {reviews.map((r) => {
            const keepFirst = !swapped[r.id];
            const left = keepFirst
              ? { name: r.keepName, id: r.keepId, tx: r.keepTransactions, strat: r.keepStrategies }
              : { name: r.mergeName, id: r.mergeId, tx: r.mergeTransactions, strat: r.mergeStrategies };
            const right = keepFirst
              ? { name: r.mergeName, id: r.mergeId, tx: r.mergeTransactions, strat: r.mergeStrategies }
              : { name: r.keepName, id: r.keepId, tx: r.keepTransactions, strat: r.keepStrategies };
            return (
              <li key={r.id} className="card p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-warn-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-warn)]">
                    <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
                    {(Number(r.score) * 100).toFixed(0)}% similar
                  </span>
                  {r.reason && <span className="truncate text-xs text-[var(--color-text-soft)]">{r.reason}</span>}
                </div>
                <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
                  <div className="rounded-lg border border-[var(--color-primary-soft)] bg-[var(--color-primary-tint)] p-3">
                    <p className="eyebrow mb-1 text-[var(--color-primary)]">Keep</p>
                    <Person {...left} />
                  </div>
                  <div className="text-center text-xs text-[var(--color-text-soft)]">
                    ← merge into
                    {canManage && (
                      <button type="button" onClick={() => setSwapped((s) => ({ ...s, [r.id]: !s[r.id] }))} className="mt-1 block w-full text-[var(--color-primary)] hover:underline">
                        swap
                      </button>
                    )}
                  </div>
                  <div className="rounded-lg border border-[var(--color-rule)] p-3">
                    <p className="eyebrow mb-1">Fold in</p>
                    <Person {...right} />
                  </div>
                </div>
                {canManage && (
                  <div className="mt-3 flex justify-end gap-2">
                    <button type="button" onClick={() => decide(r, "reject")} disabled={busy === r.id} className="btn btn-sm btn-secondary">
                      Not the same person
                    </button>
                    <button type="button" onClick={() => decide(r, "confirm")} disabled={busy === r.id} className="btn btn-sm btn-primary">
                      {busy === r.id ? "Merging…" : "Confirm — same person"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
