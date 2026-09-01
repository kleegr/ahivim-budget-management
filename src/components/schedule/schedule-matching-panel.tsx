"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2, Search, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import type { PlanningMatchReason, PlanningMatchReview } from "@/lib/data/planning-reconciliation";
import { formatHours } from "@/lib/money";

const STATUS: Record<PlanningMatchReason, { label: string; className: string }> = {
  group: {
    label: "Group review needed",
    className: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  },
  multiple: {
    label: "Multiple possible records",
    className: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  },
  none: {
    label: "No recorded service found",
    className: "bg-[var(--color-surface-strong)] text-[var(--color-ink-soft)]",
  },
  pay_period: {
    label: "Pay-period record needs review",
    className: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  },
  possible: {
    label: "One possible daily record",
    className: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
  },
};

function matchReviewCountLabel(
  filteredCount: number,
  loadedCount: number,
  totalCount: number,
  hasActiveFilters: boolean,
): string {
  if (!hasActiveFilters) return `Showing ${loadedCount} of ${totalCount} unmatched visits.`;
  if (loadedCount < totalCount) {
    return `Showing ${filteredCount} matches from ${loadedCount} loaded of ${totalCount} total unmatched visits.`;
  }
  return `Showing ${filteredCount} of ${totalCount} unmatched visits for these filters.`;
}

function matchReviewEmptyLabel(loadedCount: number, totalCount: number): string {
  if (totalCount === 0) return "Every past planned visit is matched.";
  if (loadedCount < totalCount) {
    return `No matches in the ${loadedCount} loaded visits. Refine the search or filter to check a different part of the review.`;
  }
  return "No visits match these filters.";
}

export default function ScheduleMatchingPanel({ review }: { review: PlanningMatchReview }) {
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState<"all" | PlanningMatchReason>("all");
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return review.rows.filter((row) => (
      (reason === "all" || row.reason === reason)
      && (!needle || `${row.employeeName ?? ""} ${row.programName} ${row.programCode} ${row.individualNames.join(" ")}`
        .toLocaleLowerCase().includes(needle))
    ));
  }, [query, reason, review.rows]);
  const loadedCount = review.rows.length;
  const hasActiveFilters = query.trim().length > 0 || reason !== "all";

  return (
    <section aria-labelledby="schedule-matching-heading">
      <div className="mb-4">
        <h2 id="schedule-matching-heading" className="display text-base font-semibold">Recorded service match review</h2>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          Past planned visits that are not yet connected to recorded service. Possible records may cover a full pay period and still need review. Group hours are credited per person. This view contains hours only.
        </p>
      </div>

      <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule-strong)] sm:grid-cols-4 sm:divide-y-0">
        <Summary label="Still unmatched" value={review.total} />
        <Summary label="Group visits" value={review.groupCount} tone={review.groupCount > 0 ? "warn" : undefined} />
        <Summary label="Multiple possibilities" value={review.multipleCount} tone={review.multipleCount > 0 ? "alert" : undefined} />
        <Summary label="No recorded service" value={review.noCandidateCount} />
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1 text-xs font-semibold text-[var(--color-ink-soft)]">
          Find a person, employee, or program
          <span className="relative mt-1 block">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-faint)]" />
            <input className="input min-h-10 w-full pl-9 text-sm font-normal" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
          </span>
        </label>
        <label className="min-w-56 text-xs font-semibold text-[var(--color-ink-soft)]">
          Review reason
          <select className="input mt-1 min-h-10 w-full text-sm font-normal" value={reason} onChange={(event) => setReason(event.target.value as typeof reason)}>
            <option value="all">All reasons</option>
            <option value="group">Group review needed</option>
            <option value="multiple">Multiple possible records</option>
            <option value="pay_period">Pay-period record needs review</option>
            <option value="possible">One possible daily record</option>
            <option value="none">No recorded service found</option>
          </select>
        </label>
      </div>

      <p aria-live="polite" className="mt-3 text-xs text-[var(--color-ink-soft)]">
        {matchReviewCountLabel(filtered.length, loadedCount, review.total, hasActiveFilters)}
      </p>

      {filtered.length === 0 ? (
        <div className="mt-5 flex items-center justify-center gap-2 border-y border-[var(--color-rule)] py-9 text-sm text-[var(--color-ink-soft)]">
          {review.total === 0 ? <CheckCircle2 aria-hidden className="h-4 w-4 text-[var(--color-success)]" /> : null}
          <span>{matchReviewEmptyLabel(loadedCount, review.total)}</span>
        </div>
      ) : (
        <div className="scroll-thin mt-4 overflow-x-auto border-y border-[var(--color-rule-strong)]">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] text-left text-xs font-semibold text-[var(--color-ink-soft)]">
              <tr>
                <th className="px-3 py-2.5">Date</th>
                <th className="px-3 py-2.5">Person</th>
                <th className="px-3 py-2.5">Employee</th>
                <th className="px-3 py-2.5">Program</th>
                <th className="px-3 py-2.5 text-right">Planned per person</th>
                <th className="px-3 py-2.5 text-right">Possible credited hours</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-rule)]">
              {filtered.map((row) => {
                const status = STATUS[row.reason];
                return (
                  <tr key={row.id}>
                    <td className="tnum whitespace-nowrap px-3 py-3">{row.sessionDate}</td>
                    <td className="px-3 py-3 font-medium">
                      <span>{row.individualNames.join(", ")}</span>
                      {row.isGroup ? <span className="mt-1 flex items-center gap-1 text-xs text-[var(--color-ink-faint)]"><UsersRound aria-hidden className="h-3.5 w-3.5" />{row.groupSize} people</span> : null}
                    </td>
                    <td className="px-3 py-3 text-[var(--color-ink-soft)]">{row.employeeName ?? "Unassigned"}</td>
                    <td className="px-3 py-3"><span className="block">{row.programName}</span><span className="text-xs text-[var(--color-ink-faint)]">{row.programCode}</span></td>
                    <td className="tnum px-3 py-3 text-right">{formatHours(row.plannedHours)}{row.isGroup ? " each" : ""}</td>
                    <td className="tnum px-3 py-3 text-right">
                      {row.candidateCount > 0 ? <><span className="font-semibold">{formatHours(row.candidateHours)}</span><span className="ml-1 text-xs text-[var(--color-ink-faint)]">({row.candidateCount})</span></> : "-"}
                    </td>
                    <td className="px-3 py-3"><span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold ${status.className}`}>{row.reason === "multiple" ? <AlertTriangle aria-hidden className="h-3.5 w-3.5" /> : null}{status.label}</span></td>
                    <td className="px-3 py-3 text-right"><Link className="btn btn-sm btn-secondary" href={`/schedule?view=calendar&calendarView=day&date=${row.sessionDate}&sessionId=${row.id}`}>Open visit</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Summary({ label, value, tone }: { label: string; value: number; tone?: "warn" | "alert" }) {
  const color = tone === "alert" ? "text-[var(--color-danger)]" : tone === "warn" ? "text-[var(--color-warn)]" : "text-[var(--color-ink)]";
  return <div className="min-h-20 px-3 py-3"><p className={`tnum text-xl font-semibold ${color}`}>{value.toLocaleString()}</p><p className="mt-1 text-xs text-[var(--color-ink-soft)]">{label}</p></div>;
}
