"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { type UtilizationStatus } from "@/components/ui-viz";
import { Badge } from "@/components/ui";
import { ActionButton } from "@/components/manage/client";
import { BUDGET_STATUS_PRESENT, BUDGET_STATUS_RANK, type BudgetLineStatus } from "@/lib/business/budget-status";

/**
 * The Individuals register, redesigned as a fast client grid that previews the
 * one thing you came to check: is this person's budget OK? Each row carries a
 * pace bar, % used, renewal date and a status badge — the same status language
 * as Projections — so the list is a mini-portfolio, not just a column of names.
 *
 * Filtering and sorting happen live in the browser (the Google-Sheets reflex),
 * so there is no "Apply filters / full page reload" round-trip any more.
 */

export type IndividualBudget = {
  status: UtilizationStatus;
  plainStatus: BudgetLineStatus; // plain words shown to the user (matches the profile)
  usedPct: number | null; // 0–100
  elapsedPct: number | null; // 0–100, for the pace-bar notch
  renews: string | null; // YYYY-MM-DD
  hoursLeft: number | null;
  plans: number;
  daysToRenewal: number | null;
  expired: boolean;
  mustUseWeekly: number | null;
};

export type IndividualRow = {
  id: string;
  name: string;
  preferredName: string | null;
  status: string; // lifecycle: active / inactive / discharged / archived
  archived: boolean;
  programs: string[];
  budget: IndividualBudget | null;
  hasBilling: boolean;
};

const fmtHrs = (h: number | null) =>
  h === null ? "—" : `${Math.round(h).toLocaleString()} h`;

function RenewChip({ b }: { b: IndividualBudget }) {
  if (b.renews === null) return null;
  const d = b.daysToRenewal;
  if (d === null) return <span className="tnum text-[var(--color-ink-soft)]">{b.renews}</span>;
  const soon = d >= 0 && d <= 60;
  const cls = b.expired
    ? "text-[var(--color-danger)]"
    : soon
      ? "text-[var(--color-warn)]"
      : "text-[var(--color-ink-soft)]";
  const note = b.expired ? "expired" : d <= 60 ? `in ${d}d` : null;
  return (
    <span className={`tnum ${cls}`}>
      {b.renews}
      {note ? <span className="ml-1 text-[0.7rem] font-medium">· {note}</span> : null}
    </span>
  );
}

type SortKey = "name" | "programs" | "health" | "used" | "left" | "renews" | "status";

function StatusPill({ status }: { status: BudgetLineStatus }) {
  const s = BUDGET_STATUS_PRESENT[status];
  return (
    <span className="badge" style={{ background: s.tint, color: s.color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

function PaceBar({ budget }: { budget: IndividualBudget }) {
  const used = Math.max(0, Math.min(100, budget.usedPct ?? 0));
  const color = BUDGET_STATUS_PRESENT[budget.plainStatus].color;
  return (
    <div
      className="pace-track"
      role="img"
      aria-label={`${Math.round(used)}% of budget hours used`}
      title={
        budget.elapsedPct !== null
          ? `${Math.round(used)}% of hours used · ${Math.round(budget.elapsedPct)}% of the budget period elapsed`
          : `${Math.round(used)}% of hours used`
      }
    >
      <div className="pace-fill" style={{ width: `${used}%`, background: color }} />
      {budget.elapsedPct !== null ? (
        <div className="pace-notch" style={{ left: `${Math.max(0, Math.min(100, budget.elapsedPct))}%` }} />
      ) : null}
    </div>
  );
}

export default function IndividualsList({ rows, canEdit }: { rows: IndividualRow[]; canEdit: boolean }) {
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "health", dir: "asc" });

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = rows.filter((r) => (showArchived ? true : !r.archived));
    if (needle) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          (r.preferredName ?? "").toLowerCase().includes(needle) ||
          r.programs.some((p) => p.toLowerCase().includes(needle)),
      );
    }
    const healthRank = (r: IndividualRow) => (r.budget ? 9 - BUDGET_STATUS_RANK[r.budget.plainStatus] : 99);
    const cmp = (a: IndividualRow, b: IndividualRow): number => {
      let d = 0;
      switch (sort.key) {
        case "name":
          d = a.name.localeCompare(b.name);
          break;
        case "programs":
          d = a.programs.join(",").localeCompare(b.programs.join(","));
          break;
        case "health":
        case "status":
          d = sort.key === "status" ? a.status.localeCompare(b.status) : healthRank(a) - healthRank(b);
          break;
        case "used":
          d = (a.budget?.usedPct ?? -1) - (b.budget?.usedPct ?? -1);
          break;
        case "left":
          d = (a.budget?.hoursLeft ?? -1) - (b.budget?.hoursLeft ?? -1);
          break;
        case "renews":
          d = (a.budget?.renews ?? "9999").localeCompare(b.budget?.renews ?? "9999");
          break;
      }
      if (d === 0) d = a.name.localeCompare(b.name);
      return sort.dir === "asc" ? d : -d;
    };
    return list.slice().sort(cmp);
  }, [rows, q, showArchived, sort]);

  const archivedCount = useMemo(() => rows.filter((r) => r.archived).length, [rows]);

  const toggle = (key: SortKey) =>
    setSort((p) => (p.key === key ? { key, dir: p.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "used" ? "desc" : "asc" }));

  const Head = ({ k, children, align = "left" }: { k: SortKey; children: React.ReactNode; align?: "left" | "right" }) => (
    <th className={`whitespace-nowrap border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 font-semibold ${align === "right" ? "text-right" : "text-left"}`}>
      <button type="button" onClick={() => toggle(k)} className={`inline-flex items-center gap-1 hover:underline ${align === "right" ? "flex-row-reverse" : ""}`} title="Sort">
        {children}
        <span className="text-[10px] text-[var(--color-primary)]">{sort.key === k ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
      </button>
    </th>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a name or program…"
          className="input w-64 max-w-full"
          aria-label="Search individuals"
        />
        {archivedCount > 0 ? (
          <label className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived ({archivedCount})
          </label>
        ) : null}
        <span className="ml-auto text-sm text-[var(--color-text-soft)]">
          <span className="tnum font-semibold text-[var(--color-ink)]">{visible.length}</span>{" "}
          {visible.length === 1 ? "person" : "people"}
        </span>
      </div>

      <div className="scroll-thin max-h-[68vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              <Head k="name">Name</Head>
              <Head k="programs">Programs</Head>
              <th className="whitespace-nowrap border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 text-left font-semibold" style={{ minWidth: 140 }}>
                Budget health
              </th>
              <Head k="used" align="right">% used</Head>
              <Head k="left" align="right">Hours left</Head>
              <Head k="renews">Renews</Head>
              <Head k="status">Status</Head>
              {canEdit ? <th className="border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 text-left font-semibold">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className="border-b border-[var(--color-rule)] hover:bg-[var(--color-surface-muted)]">
                <td className="px-3 py-2">
                  <Link className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline" href={`/individuals/${r.id}`}>
                    {r.name}
                  </Link>
                  {r.preferredName ? <span className="text-[var(--color-ink-faint)]"> ({r.preferredName})</span> : null}
                </td>
                <td className="px-3 py-2 text-[var(--color-ink-soft)]">{r.programs.length ? r.programs.join(", ") : <span className="text-[var(--color-ink-faint)]">—</span>}</td>
                <td className="px-3 py-2">
                  {r.budget ? (
                    <PaceBar budget={r.budget} />
                  ) : r.hasBilling ? (
                    <span className="text-xs font-medium text-[var(--color-warn)]">Billing, no budget on file</span>
                  ) : (
                    <span className="text-xs text-[var(--color-ink-faint)]">No active budget</span>
                  )}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {r.budget && r.budget.usedPct !== null ? `${Math.round(r.budget.usedPct)}%` : <span className="text-[var(--color-ink-faint)]">—</span>}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {r.budget && r.budget.hoursLeft !== null ? (
                    <span title={r.budget.mustUseWeekly && r.budget.mustUseWeekly > 0 ? `Use ~${Math.round(r.budget.mustUseWeekly)} h/week to finish by renewal` : undefined}>
                      {fmtHrs(r.budget.hoursLeft)}
                    </span>
                  ) : (
                    <span className="text-[var(--color-ink-faint)]">—</span>
                  )}
                </td>
                <td className="tnum px-3 py-2 text-[var(--color-ink-soft)]">{r.budget ? <RenewChip b={r.budget} /> : <span className="text-[var(--color-ink-faint)]">—</span>}</td>
                <td className="px-3 py-2">
                  {r.budget ? <StatusPill status={r.budget.plainStatus} /> : <Badge value={r.status} />}
                </td>
                {canEdit ? (
                  <td className="whitespace-nowrap px-3 py-2">
                    {r.archived ? (
                      <ActionButton label="Restore" endpoint={`/api/individuals/${r.id}`} body={{ action: "restore" }} withReason />
                    ) : (
                      <ActionButton label="Archive" endpoint={`/api/individuals/${r.id}`} body={{ action: "archive" }} withReason />
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={canEdit ? 8 : 7} className="px-3 py-10 text-center text-[var(--color-text-soft)]">
                  {rows.length === 0 ? "No individuals yet — they appear here once a workbook is committed." : "No one matches your search."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {r_lifecycleNote(rows)}
    </div>
  );
}

/** A quiet footnote when some people carry a non-active lifecycle status. */
function r_lifecycleNote(rows: IndividualRow[]) {
  const nonActive = rows.filter((r) => !r.archived && r.status !== "active").length;
  if (nonActive === 0) return null;
  return (
    <p className="text-xs text-[var(--color-ink-faint)]">
      A budget status is shown for people with an active plan; the grey badge is the person&rsquo;s account status
      (inactive / discharged) when there is no active budget.
    </p>
  );
}
