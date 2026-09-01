"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ScheduledLine, BilledLine } from "@/lib/manage/reconciliation";
import { Card, Table, Th, Td, Tr, Money, Hours, Badge, EmptyState } from "@/components/ui";

/** Uniform write/read helper — every request surfaces the server's own error text. */
async function send(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; data?: unknown };
    if (!res.ok || json.ok === false) return { ok: false, error: json.error ?? `Request failed (${res.status}).` };
    return { ok: true, data: json.data };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

export interface ReconcileClientProps {
  canManage: boolean;
  from: string;
  to: string;
  programId: string;
  scheduled: ScheduledLine[];
  billed: BilledLine[];
}

function periodLabel(begin: string | null, end: string | null): string {
  if (begin && end) return `${begin} – ${end}`;
  return begin ?? end ?? "—";
}

export default function ReconcileClient({
  canManage,
  from,
  to,
  programId,
  scheduled,
  billed,
}: ReconcileClientProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null); // session id, or "auto"
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [matchTarget, setMatchTarget] = useState<ScheduledLine | null>(null);
  const [candidates, setCandidates] = useState<BilledLine[] | null>(null);
  const [reason, setReason] = useState("");

  async function autoReconcile() {
    if (!window.confirm("Auto-match every obvious single-individual session in this range? Group and ambiguous sessions are skipped.")) return;
    setBusy("auto");
    setError(null);
    setNotice(null);
    const res = await send("POST", "/api/reconciliation", {
      action: "auto",
      from,
      to,
      programId: programId || undefined,
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Auto-reconcile failed.");
      return;
    }
    const data = res.data as { matched?: number; considered?: number } | undefined;
    setNotice(`Auto-matched ${data?.matched ?? 0} of ${data?.considered ?? 0} considered.`);
    router.refresh();
  }

  async function openMatch(session: ScheduledLine) {
    setMatchTarget(session);
    setCandidates(null);
    setReason("");
    setError(null);
    const res = await send("GET", `/api/reconciliation/${session.id}`);
    if (!res.ok) {
      setError(res.error ?? "Could not load candidate transactions.");
      setCandidates([]);
      return;
    }
    setCandidates((res.data as BilledLine[]) ?? []);
  }

  async function confirmMatch(transactionId: string) {
    if (!matchTarget) return;
    setBusy(matchTarget.id);
    setError(null);
    const res = await send("PATCH", `/api/reconciliation/${matchTarget.id}`, {
      action: "match",
      transactionId,
      reason: reason.trim() || undefined,
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Could not match this session.");
      return;
    }
    setMatchTarget(null);
    setCandidates(null);
    router.refresh();
  }

  async function unmatch(session: ScheduledLine) {
    if (!window.confirm("Break the match on this session?")) return;
    setBusy(session.id);
    setError(null);
    setNotice(null);
    const res = await send("PATCH", `/api/reconciliation/${session.id}`, { action: "unmatch" });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Could not unmatch this session.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {(error || notice) ? (
        <div className="space-y-2">
          {error ? (
            <p role="alert" className="rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-pace-over)]">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-2 text-sm text-[var(--color-primary)]">
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}

      <Card
        title="Scheduled sessions"
        description="Planned sessions in range and their match state."
        action={
          canManage ? (
            <button
              type="button"
              onClick={autoReconcile}
              disabled={busy !== null}
              className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {busy === "auto" ? "Reconciling…" : "Auto-reconcile this range"}
            </button>
          ) : undefined
        }
      >
        {scheduled.length === 0 ? (
          <EmptyState title="No scheduled sessions">Nothing is planned in this range for the chosen filters.</EmptyState>
        ) : (
          <Table
            caption="Scheduled sessions and their reconciliation state"
            head={
              <>
                <Th>Date</Th>
                <Th>Program</Th>
                <Th>Individuals</Th>
                <Th numeric>Hours</Th>
                <Th numeric>Employee base</Th>
                <Th>Match</Th>
                {canManage ? <Th>Action</Th> : null}
              </>
            }
          >
            {scheduled.map((s) => (
              <Tr key={s.id}>
                <Td className="tnum whitespace-nowrap">{s.sessionDate}</Td>
                <Td>
                  {s.programCode}
                  {s.isGroup ? <span className="ml-1 text-xs text-[var(--color-ink-faint)]">· group</span> : null}
                </Td>
                <Td>{s.individualNames.length ? s.individualNames.join(", ") : <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                <Td numeric><Hours value={s.hours} /></Td>
                <Td numeric><Money value={s.expectedInternal} /></Td>
                <Td>
                  {s.matchedTransactionId ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <Badge value="valid" label="Matched" />
                      <span className="text-xs text-[var(--color-ink-soft)]">
                        <Hours value={s.matchedHours} /> · <Money value={s.matchedAmount} />
                      </span>
                    </span>
                  ) : (
                    <Badge value="needs_review" label="Unmatched" />
                  )}
                </Td>
                {canManage ? (
                  <Td>
                    {s.matchedTransactionId ? (
                      <button
                        type="button"
                        onClick={() => unmatch(s)}
                        disabled={busy !== null}
                        className="rounded border border-[var(--color-rule-strong)] px-2 py-1 text-xs font-medium disabled:opacity-60"
                      >
                        {busy === s.id ? "…" : "Unmatch"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openMatch(s)}
                        disabled={busy !== null}
                        className="rounded bg-[var(--color-primary)] px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
                      >
                        Match
                      </button>
                    )}
                  </Td>
                ) : null}
              </Tr>
            ))}
          </Table>
        )}
      </Card>

      <Card
        title="Billed, not scheduled"
        description="Imported transactions in range with no matching planned session."
      >
        {billed.length === 0 ? (
          <EmptyState title="Nothing outstanding">Every billed transaction in this range is matched to a session.</EmptyState>
        ) : (
          <Table
            caption="Imported transactions with no scheduled match"
            head={
              <>
                <Th>Service period / date</Th>
                <Th>Program</Th>
                <Th>Individual</Th>
                <Th numeric>Hours</Th>
                <Th numeric>Funder billed</Th>
              </>
            }
          >
            {billed.map((b) => (
              <Tr key={b.id}>
                <Td className="tnum whitespace-nowrap">
                  {b.periodBegin && b.periodEnd
                    ? periodLabel(b.periodBegin, b.periodEnd)
                    : b.serviceDate ?? periodLabel(b.periodBegin, b.periodEnd)}
                </Td>
                <Td>{b.programCode ?? <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                <Td>{b.individualName ?? <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                <Td numeric><Hours value={b.hours} /></Td>
                <Td numeric><Money value={b.amount} /></Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>

      {matchTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="Match session"
        >
          <div className="mt-6 w-full max-w-2xl rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] shadow-xl">
            <div className="flex items-center justify-between border-b border-[var(--color-rule)] px-5 py-3">
              <div>
                <h2 className="display text-base font-medium">Match a transaction</h2>
                <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                  {matchTarget.sessionDate} · {matchTarget.programCode} · {matchTarget.individualNames.join(", ") || "—"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { setMatchTarget(null); setCandidates(null); }}
                aria-label="Close"
                className="rounded px-2 py-1 text-sm text-[var(--color-ink-faint)] hover:bg-[var(--color-paper)]"
              >
                ✕
              </button>
            </div>
            <div className="px-5 py-4">
              <label className="mb-3 block">
                <span className="text-sm font-medium">Reason (optional, recorded in the audit log)</span>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="mt-1 w-full rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 text-sm"
                  placeholder="Why this match"
                />
              </label>

              {candidates === null ? (
                <p className="py-6 text-center text-sm text-[var(--color-ink-faint)]">Loading candidate transactions…</p>
              ) : candidates.length === 0 ? (
                <EmptyState title="No candidate transactions">
                  No unmatched transaction covers this session&rsquo;s individual, program, and date.
                </EmptyState>
              ) : (
                <Table
                  caption="Candidate transactions"
                  head={
                    <>
                      <Th>Period</Th>
                      <Th>Program</Th>
                      <Th>Individual</Th>
                      <Th numeric>Hours</Th>
                      <Th numeric>Funder billed</Th>
                      <Th>Use</Th>
                    </>
                  }
                >
                  {candidates.map((c) => (
                    <Tr key={c.id}>
                      <Td className="tnum whitespace-nowrap">{periodLabel(c.periodBegin, c.periodEnd)}</Td>
                      <Td>{c.programCode ?? <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                      <Td>{c.individualName ?? <span className="text-[var(--color-ink-faint)]">—</span>}</Td>
                      <Td numeric><Hours value={c.hours} /></Td>
                      <Td numeric><Money value={c.amount} /></Td>
                      <Td>
                        <button
                          type="button"
                          onClick={() => confirmMatch(c.id)}
                          disabled={busy !== null}
                          className="rounded bg-[var(--color-primary)] px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
                        >
                          {busy === matchTarget.id ? "…" : "Use"}
                        </button>
                      </Td>
                    </Tr>
                  ))}
                </Table>
              )}

              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => { setMatchTarget(null); setCandidates(null); }}
                  className="rounded border border-[var(--color-rule-strong)] px-3 py-1.5 text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
