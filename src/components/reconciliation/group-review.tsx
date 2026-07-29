"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { GroupCandidate, GroupClassification } from "@/lib/manage/group-detection";
import { Card, Table, Th, Td, Tr, Money, Hours, Badge, EmptyState, StatTile } from "@/components/ui";

/** Candidate plus the server-computed classification, so the client stays presentational. */
export type ReviewCandidate = GroupCandidate & { classification: GroupClassification };

const CLASSIFICATION_LABELS: Record<GroupClassification, string> = {
  confirmed: "Confirmed",
  probable: "Probable",
  requires_review: "Requires review",
  not_a_group: "Not a group",
};

const STATUS_LABELS: Record<string, string> = {
  single: "Single",
  detected: "Detected",
  needs_review: "Needs review",
  confirmed: "Confirmed",
};

async function send(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) return { ok: false, error: json.error ?? `Request failed (${res.status}).` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

function periodLabel(begin: string | null, end: string | null): string {
  if (begin && end) return `${begin} – ${end}`;
  return begin ?? end ?? "—";
}

/** A single money-conservation assertion: the claim, whether it holds, and the figures behind it. */
function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span
        aria-hidden
        className={ok ? "text-[var(--color-pace-on)]" : "text-[var(--color-pace-over)]"}
      >
        {ok ? "✓" : "✗"}
      </span>
      <span>
        <span className="font-medium">{label}</span>{" "}
        <span className="text-[var(--color-ink-faint)]">{detail}</span>
      </span>
    </li>
  );
}

export interface GroupReviewClientProps {
  canManage: boolean;
  candidates: ReviewCandidate[];
}

export default function GroupReviewClient({ canManage, candidates }: GroupReviewClientProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const counts = candidates.reduce<Record<GroupClassification, number>>(
    (acc, c) => {
      acc[c.classification] += 1;
      return acc;
    },
    { confirmed: 0, probable: 0, requires_review: 0, not_a_group: 0 },
  );

  async function act(candidate: ReviewCandidate, action: "confirm" | "reject" | "review") {
    const verb = action === "confirm" ? "Confirm" : action === "reject" ? "Reject" : "Send back for review";
    if (!window.confirm(`${verb} this detected group? The allocations are not changed — only its status.`)) return;
    setBusy(candidate.id);
    setError(null);
    setNotice(null);
    const res = await send("PATCH", `/api/group-detection/${candidate.id}`, { action });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Could not update this group.");
      return;
    }
    setNotice(`Group ${action === "reject" ? "rejected" : action === "confirm" ? "confirmed" : "sent for review"}.`);
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

      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile label="Confirmed" value={counts.confirmed.toLocaleString()} tone={counts.confirmed ? "good" : "neutral"} />
        <StatTile label="Probable" value={counts.probable.toLocaleString()} tone={counts.probable ? "warn" : "neutral"} />
        <StatTile label="Requires review" value={counts.requires_review.toLocaleString()} tone={counts.requires_review ? "alert" : "neutral"} />
        <StatTile label="Not a group" value={counts.not_a_group.toLocaleString()} tone="neutral" />
      </div>

      {candidates.length === 0 ? (
        <Card title="Group candidates">
          <EmptyState title="No group candidates">
            The importer has not detected any multi-individual sessions to review.
          </EmptyState>
        </Card>
      ) : (
        candidates.map((c) => (
          <Card
            key={c.id}
            title={`${c.programCode ?? "—"} · ${c.groupSize} individuals`}
            description={`${c.employeeName ?? "Unknown employee"} · ${periodLabel(c.periodBegin, c.periodEnd)}`}
            action={
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Badge value={c.classification} label={CLASSIFICATION_LABELS[c.classification]} />
                <Badge value={c.status} label={STATUS_LABELS[c.status] ?? c.status} />
              </span>
            }
          >
            <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
              <div>
                <p className="eyebrow mb-2">Members and their split</p>
                {c.members.length === 0 ? (
                  <p className="text-sm text-[var(--color-ink-faint)]">
                    No allocations were written for this session — nothing to reconcile yet.
                  </p>
                ) : (
                  <Table
                    caption="Group members and their allocated share"
                    head={
                      <>
                        <Th>Individual</Th>
                        <Th numeric>Hours</Th>
                        <Th numeric>Amount</Th>
                      </>
                    }
                  >
                    {c.members.map((m) => (
                      <Tr key={m.individualId}>
                        <Td>{m.name}</Td>
                        <Td numeric><Hours value={m.allocationHours} /></Td>
                        <Td numeric><Money value={m.allocatedAmount} /></Td>
                      </Tr>
                    ))}
                  </Table>
                )}
              </div>

              <div>
                <p className="eyebrow mb-2">Evidence</p>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <dt className="text-[var(--color-ink-faint)]">Physical hours</dt>
                  <dd className="text-right"><Hours value={c.physicalHours} /></dd>
                  <dt className="text-[var(--color-ink-faint)]">Combined amount</dt>
                  <dd className="text-right"><Money value={c.combinedAmount} /></dd>
                  <dt className="text-[var(--color-ink-faint)]">Combined rate</dt>
                  <dd className="text-right"><Money value={c.combinedRate} /></dd>
                  <dt className="text-[var(--color-ink-faint)]">Base individual rate</dt>
                  <dd className="text-right"><Money value={c.baseIndividualRate} /></dd>
                  <dt className="text-[var(--color-ink-faint)]">Detection rule</dt>
                  <dd className="text-right">{c.detectionRule ?? "—"}</dd>
                </dl>

                <p className="eyebrow mt-3 mb-2">Money conservation</p>
                <ul className="space-y-1">
                  <Check
                    ok={c.moneyReconciles}
                    label="Split adds back to combined"
                    detail={`Σ allocations $${c.allocatedSum} vs combined $${c.combinedAmount ?? "—"}`}
                  />
                  <Check
                    ok={c.rateConsistent}
                    label="Rate math consistent"
                    detail={`combined $${c.combinedRate ?? "—"} vs ${c.groupSize} × base = $${c.expectedCombinedRate ?? "—"}`}
                  />
                  <Check
                    ok={c.memberCountMatches}
                    label="Member count matches group size"
                    detail={`${c.memberCount} of ${c.groupSize}`}
                  />
                </ul>
              </div>
            </div>

            {canManage ? (
              <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-rule)] px-5 py-3">
                <button
                  type="button"
                  onClick={() => act(c, "confirm")}
                  disabled={busy !== null}
                  className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
                >
                  {busy === c.id ? "…" : "Confirm group"}
                </button>
                <button
                  type="button"
                  onClick={() => act(c, "review")}
                  disabled={busy !== null}
                  className="rounded border border-[var(--color-rule-strong)] px-3 py-1.5 text-sm font-medium disabled:opacity-60"
                >
                  Needs review
                </button>
                <button
                  type="button"
                  onClick={() => act(c, "reject")}
                  disabled={busy !== null}
                  className="rounded border border-[var(--color-pace-over)] px-3 py-1.5 text-sm font-medium text-[var(--color-pace-over)] disabled:opacity-60"
                >
                  Reject (not a group)
                </button>
              </div>
            ) : null}
          </Card>
        ))
      )}
    </div>
  );
}
