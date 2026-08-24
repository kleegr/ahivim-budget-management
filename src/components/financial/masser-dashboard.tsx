"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CalendarClock,
  ChevronRight,
  LayoutList,
  Phone,
  Plus,
  Settings2,
  TableProperties,
} from "lucide-react";
import { dec, formatMoney } from "@/lib/money";
import type { MasserSheet, MasserSheetRow } from "@/lib/data/masser-sheet";
import type { BudgetCandidate } from "@/lib/data/financial-dashboard";
import { useGrid } from "@/components/data-grid/use-grid";
import { Toolbar } from "@/components/data-grid/toolbar";
import { FilterBar, HeaderFilter } from "@/components/data-grid/filter-bar";
import SortMenu from "@/components/data-grid/sort-menu";
import { isNumericKind, type ColumnDef } from "@/components/data-grid/types";
import { Modal } from "@/components/manage/client";

/**
 * The Masser board — the cuts / calculation sheet, rebuilt on the shared grid
 * engine. One row per plan: the two cut %s, clock and other adjustments, the
 * authorized hours per program (the budget), the computed yearly → monthly →
 * gross-net → net, and Masser (the "After All" set-aside). Cuts, hours and Masser
 * edit inline against the plan; account (a dropdown), phone and notes edit
 * against the person. Columns show/hide/reorder from the Columns menu; the footer
 * totals every money column (the Masser total is the workbook's "Gross").
 */

type Totals = { yearlyGross: string; monthlyGross: string; grossNet: string; net: string; masser: string };

const BASE_WIDTHS: Record<string, number> = {
  individual: 190, account: 124, phone: 148,
  cut1: 78, cut2: 78, clock: 98, adjustments: 120,
  yearlyGross: 120, monthlyGross: 122, grossNet: 112, net: 112, masser: 104, notes: 220,
};
// Program columns: wide enough for the code + its rate underneath.
const PROG_W = 104;

type WorkspaceView = "overview" | "matrix";

export type AnnualFundingProgress = {
  target: string;
  expectedToDate: string;
  actualSetAside: string;
  remaining: string;
  variance: string;
  periodBegin: string | null;
  periodEnd: string | null;
};

type PlanHealth = {
  label: string;
  tone: "good" | "warn" | "danger" | "muted";
  rank: number;
};

type PersonPlanSummary = {
  individualId: string;
  individualName: string;
  labels: string[];
  active: boolean;
  account: string | null;
  renewalDate: string | null;
  hours: string;
  yearlyGross: string;
  net: string;
  plannedMasser: string;
};

function summarizePlans(rows: MasserSheetRow[]): PersonPlanSummary[] {
  const people = new Map<string, PersonPlanSummary>();
  for (const row of rows) {
    const current = people.get(row.individualId);
    const renewalDate = [current?.renewalDate, row.renewalDate]
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null;
    people.set(row.individualId, {
      individualId: row.individualId,
      individualName: row.individualName,
      labels: [...new Set([...(current?.labels ?? []), row.label || "Annual plan"])],
      active: (current?.active ?? false) || row.active,
      account: current?.account ?? row.account,
      renewalDate,
      hours: dec(current?.hours ?? 0).plus(dec(totalHours(row))).toFixed(2),
      yearlyGross: dec(current?.yearlyGross ?? 0).plus(dec(row.yearlyGross || 0)).toFixed(2),
      net: dec(current?.net ?? 0).plus(dec(row.net || 0)).toFixed(2),
      plannedMasser: dec(current?.plannedMasser ?? 0).plus(dec(row.masser || 0)).toFixed(2),
    });
  }
  return [...people.values()];
}

function planHealth(row: PersonPlanSummary, funding?: AnnualFundingProgress): PlanHealth {
  if (!row.active) return { label: "Inactive", tone: "muted", rank: 7 };
  if (!row.renewalDate) return { label: "Renewal date needed", tone: "warn", rank: 1 };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const renewal = new Date(`${row.renewalDate}T00:00:00`);
  const days = Math.ceil((renewal.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return { label: "Renewal overdue", tone: "danger", rank: 0 };
  if (days <= 60) return { label: `Renews in ${days}d`, tone: "warn", rank: 1 };
  if (dec(row.plannedMasser || 0).lessThanOrEqualTo(0)) return { label: "Set-aside target needed", tone: "warn", rank: 2 };
  if (!funding) return { label: "Funding not calculated", tone: "warn", rank: 3 };
  if (dec(funding.remaining).lessThanOrEqualTo(0)) return { label: "Fully set aside", tone: "good", rank: 6 };
  if (dec(funding.variance).isNegative()) return { label: "Behind annual pace", tone: "danger", rank: 2 };
  return { label: "On annual pace", tone: "good", rank: 5 };
}

const HEALTH_STYLE: Record<PlanHealth["tone"], string> = {
  good: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
  warn: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  muted: "bg-[var(--color-surface-strong)] text-[var(--color-ink-soft)]",
};

function totalHours(row: MasserSheetRow): string {
  return Object.values(row.hours).reduce((total, value) => total.plus(dec(value || 0)), dec(0)).toFixed(2);
}

function PlanOverview({
  data,
  funding,
  onOpenMatrix,
}: {
  data: MasserSheet;
  funding: Record<string, AnnualFundingProgress>;
  onOpenMatrix: () => void;
}) {
  const [query, setQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const people = useMemo(() => summarizePlans(data.rows), [data.rows]);
  const totals = useMemo(() => {
    let target = dec(0);
    let actual = dec(0);
    let remaining = dec(0);
    let needsAttention = 0;
    for (const row of people) {
      if (!row.active) continue;
      const progress = funding[row.individualId];
      target = target.plus(dec(progress?.target ?? row.plannedMasser));
      actual = actual.plus(dec(progress?.actualSetAside ?? 0));
      remaining = remaining.plus(dec(progress?.remaining ?? row.plannedMasser));
      if (planHealth(row, progress).rank <= 3) needsAttention += 1;
    }
    return { target, actual, remaining, needsAttention, people: people.filter((row) => row.active).length };
  }, [funding, people]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return people
      .filter((row) => {
        const health = planHealth(row, funding[row.individualId]);
        if (attentionOnly && health.rank > 3) return false;
        if (!needle) return true;
        return `${row.individualName} ${row.labels.join(" ")} ${row.account ?? ""}`.toLowerCase().includes(needle);
      })
      .sort((a, b) => {
        const rank = planHealth(a, funding[a.individualId]).rank - planHealth(b, funding[b.individualId]).rank;
        return rank || a.individualName.localeCompare(b.individualName);
      });
  }, [attentionOnly, funding, people, query]);

  const metric = "min-w-0 px-5 py-4 first:pl-0 last:pr-0";

  return (
    <div className="space-y-5">
      <section aria-label="Annual plan summary" className="grid border-y border-[var(--color-rule)] sm:grid-cols-2 lg:grid-cols-5 lg:divide-x lg:divide-[var(--color-rule)]">
        <div className={metric}>
          <p className="eyebrow">People with plans</p>
          <p className="tnum mt-1 text-2xl font-semibold">{totals.people.toLocaleString()}</p>
        </div>
        <div className={metric}>
          <p className="eyebrow">Needs attention</p>
          <p className={`tnum mt-1 text-2xl font-semibold ${totals.needsAttention ? "text-[var(--color-warn)]" : "text-[var(--color-success)]"}`}>{totals.needsAttention.toLocaleString()}</p>
        </div>
        <div className={metric}>
          <p className="eyebrow">Annual target</p>
          <p className="tnum mt-1 text-2xl font-semibold">{formatMoney(totals.target.toFixed(2))}</p>
        </div>
        <div className={metric}>
          <p className="eyebrow">Set aside to date</p>
          <p className="tnum mt-1 text-2xl font-semibold text-[var(--color-success)]">{formatMoney(totals.actual.toFixed(2))}</p>
        </div>
        <div className={metric}>
          <p className="eyebrow">Remaining</p>
          <p className="tnum mt-1 text-2xl font-semibold text-[var(--color-warn)]">{formatMoney(totals.remaining.toFixed(2))}</p>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[15rem] flex-1 sm:max-w-md">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="input w-full"
            placeholder="Search a person or account"
            aria-label="Search annual plans"
          />
        </div>
        <label className="inline-flex min-h-9 items-center gap-2 text-sm text-[var(--color-ink-soft)]">
          <input type="checkbox" checked={attentionOnly} onChange={(event) => setAttentionOnly(event.target.checked)} />
          Needs attention
          {totals.needsAttention > 0 ? <span className="tnum font-semibold text-[var(--color-warn)]">{totals.needsAttention}</span> : null}
        </label>
        <span className="tnum ml-auto text-sm text-[var(--color-ink-faint)]">{rows.length.toLocaleString()} people</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)]">
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[1040px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] text-left">
                <th className="px-4 py-3 font-semibold">Individual</th>
                <th className="px-4 py-3 font-semibold">Annual status</th>
                <th className="px-4 py-3 font-semibold">Budget year</th>
                <th className="px-4 py-3 text-right font-semibold">Annual target</th>
                <th className="px-4 py-3 text-right font-semibold">Expected today</th>
                <th className="px-4 py-3 text-right font-semibold">Set aside</th>
                <th className="px-4 py-3 text-right font-semibold">Remaining</th>
                <th className="w-12 px-2 py-3"><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const progress = funding[row.individualId];
                const health = planHealth(row, progress);
                const target = progress?.target ?? row.plannedMasser;
                return (
                  <tr key={row.individualId} className="border-b border-[var(--color-rule)] last:border-0 hover:bg-[var(--color-surface-muted)]">
                    <td className="px-4 py-3">
                      <Link href={`/individuals/${row.individualId}`} className="font-semibold text-[var(--color-ink)] hover:text-[var(--color-primary)]">
                        {row.individualName}
                      </Link>
                      <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{row.labels.join(", ")}{row.account ? ` · ${row.account}` : ""} · {dec(row.hours).toDecimalPlaces(1).toString()} h</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${HEALTH_STYLE[health.tone]}`}>
                        {health.tone === "danger" || health.tone === "warn" ? <AlertCircle className="h-3.5 w-3.5" aria-hidden /> : null}
                        {health.label}
                      </span>
                    </td>
                    <td className="tnum px-4 py-3 text-[var(--color-ink-soft)]">{progress?.periodBegin && progress.periodEnd ? `${progress.periodBegin} – ${progress.periodEnd}` : row.renewalDate ? `Renews ${row.renewalDate}` : "Not set"}</td>
                    <td className="tnum px-4 py-3 text-right">{dec(target).greaterThan(0) ? formatMoney(target) : "Not set"}</td>
                    <td className="tnum px-4 py-3 text-right text-[var(--color-ink-soft)]">{progress ? formatMoney(progress.expectedToDate) : "Not calculated"}</td>
                    <td className="tnum px-4 py-3 text-right font-medium">{progress ? formatMoney(progress.actualSetAside) : "—"}</td>
                    <td className="tnum px-4 py-3 text-right font-medium text-[var(--color-warn)]">{progress ? formatMoney(progress.remaining) : formatMoney(target)}</td>
                    <td className="px-2 py-3 text-right">
                      <Link href={`/individuals/${row.individualId}`} className="icon-button" aria-label={`Open ${row.individualName}`}>
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-[var(--color-ink-soft)]">No plans match the current view.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-[var(--color-rule)] pt-4">
        <div className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
          <CalendarClock className="h-4 w-4" aria-hidden />
          Annual targets are measured against each person&apos;s renewal year.
        </div>
        <button type="button" onClick={onOpenMatrix} className="btn btn-secondary">
          <TableProperties className="h-4 w-4" aria-hidden />
          Edit plan matrix
        </button>
      </div>
    </div>
  );
}

export default function MasserDashboard({
  data,
  funding = {},
  canManage,
}: {
  data: MasserSheet;
  funding?: Record<string, AnnualFundingProgress>;
  canManage: boolean;
}) {
  const [view, setView] = useState<WorkspaceView>("overview");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-rule)]">
        <div className="segmented-control" role="tablist" aria-label="Annual plan views">
          <button type="button" role="tab" aria-selected={view === "overview"} onClick={() => setView("overview")}>
            <LayoutList className="h-4 w-4" aria-hidden /> Overview
          </button>
          <button type="button" role="tab" aria-selected={view === "matrix"} onClick={() => setView("matrix")}>
            <TableProperties className="h-4 w-4" aria-hidden /> Plan matrix
          </button>
        </div>
      </div>
      {view === "overview" ? <PlanOverview data={data} funding={funding} onOpenMatrix={() => setView("matrix")} /> : <MasserMatrix data={data} canManage={canManage} />}
    </div>
  );
}

function MasserMatrix({ data, canManage }: { data: MasserSheet; canManage: boolean }) {
  const router = useRouter();
  const [rows, setRows] = useState<MasserSheetRow[]>(data.rows);
  const [accountOptions, setAccountOptions] = useState<string[]>(data.accountOptions);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [optsOpen, setOptsOpen] = useState(false);

  // Adopt fresh server data after router.refresh().
  const [seen, setSeen] = useState(data.rows);
  if (seen !== data.rows) { setSeen(data.rows); setRows(data.rows); setAccountOptions(data.accountOptions); }

  const busyKey = useCallback((id: string, k: string) => saving.has(id + ":" + k), [saving]);
  const mark = (id: string, k: string, on: boolean) =>
    setSaving((p) => { const n = new Set(p); const key = id + ":" + k; if (on) n.add(key); else n.delete(key); return n; });

  // Edit a plan field (cut %, adjustment, program hours, Masser). Grosses are
  // server-computed, so a successful save refreshes to pull the new numbers.
  const editStrategy = useCallback(async (row: MasserSheetRow, colKey: string, body: Record<string, unknown>) => {
    mark(row.strategyId, colKey, true);
    setNotice(null);
    try {
      const res = await fetch(`/api/calculation-strategies/${row.strategyId}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save.");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not save the change.");
    } finally {
      mark(row.strategyId, colKey, false);
    }
  }, [router]);

  // Edit a person field (account tag, phone, notes) — optimistic, no refresh.
  const editIndividual = useCallback(async (row: MasserSheetRow, field: "phone" | "category" | "notes", value: string | null) => {
    const prevRows = rows;
    setRows((prev) => prev.map((r) => (r.individualId === row.individualId ? { ...r, [field === "category" ? "account" : field]: value } : r)));
    mark(row.individualId, field, true);
    setNotice(null);
    try {
      const res = await fetch(`/api/individuals/${row.individualId}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ [field]: value }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save.");
    } catch (e) {
      setRows(prevRows);
      setNotice(e instanceof Error ? e.message : "Could not save the change.");
    } finally {
      mark(row.individualId, field, false);
    }
  }, [rows]);

  const addAccountOption = useCallback(async (opt: string): Promise<boolean> => {
    const next = [...accountOptions, opt];
    try {
      const res = await fetch("/api/masser/account-options", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ options: next }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error();
      setAccountOptions(Array.isArray(j.data) ? j.data : next);
      return true;
    } catch { setNotice("Could not add the option."); return false; }
  }, [accountOptions]);

  const columns = useMemo<ColumnDef<MasserSheetRow>[]>(() => {
    const pctDisplay = (frac: string) => { try { return dec(frac || 0).times(100).toDecimalPlaces(2).toString(); } catch { return ""; } };

    const base: ColumnDef<MasserSheetRow>[] = [
      {
        key: "individual", label: "Individual", kind: "text", frozen: true, width: BASE_WIDTHS.individual,
        accessor: (r) => r.individualName,
        render: (r) => (
          <span className="flex items-center gap-1.5 px-2 py-1">
            <Link href={`/individuals/${r.individualId}`} className="truncate font-medium text-[var(--color-primary)] hover:underline" title={`Open ${r.individualName}`}>{r.individualName}</Link>
            {r.label && r.label !== "1" ? <span className="shrink-0 rounded bg-[var(--color-surface-strong)] px-1 text-[10px] text-[var(--color-text-soft)]" title="Plan">{r.label}</span> : null}
            {!r.active ? <span className="shrink-0 rounded bg-[var(--color-surface-strong)] px-1 text-[10px] text-[var(--color-text-soft)]">inactive</span> : null}
          </span>
        ),
      },
      {
        key: "account", label: "Account", kind: "text", width: BASE_WIDTHS.account, accessor: (r) => r.account,
        render: (r) => <AccountCell row={r} options={accountOptions} canManage={canManage} saving={busyKey(r.individualId, "category")}
          onPick={(v) => editIndividual(r, "category", v)} onAddOption={addAccountOption} />,
      },
      {
        key: "phone", label: "Phone", kind: "text", width: BASE_WIDTHS.phone, accessor: (r) => r.phone,
        render: (r) => <PhoneCell row={r} canManage={canManage} saving={busyKey(r.individualId, "phone")} onSave={(v) => editIndividual(r, "phone", v)} />,
      },
      {
        key: "cut1", label: "1st %", kind: "percent", width: BASE_WIDTHS.cut1, exportType: "text", accessor: (r) => pctDisplay(r.cut1Percent),
        render: (r, t) => <NumCell text={t ? `${t}%` : ""} canManage={canManage} saving={busyKey(r.strategyId, "cut1")} initial={pctDisplay(r.cut1Percent)} onSave={(v) => editStrategy(r, "cut1", { cut1Percent: v })} />,
      },
      {
        key: "cut2", label: "2nd %", kind: "percent", width: BASE_WIDTHS.cut2, exportType: "text", accessor: (r) => pctDisplay(r.cut2Percent),
        render: (r, t) => <NumCell text={t ? `${t}%` : ""} canManage={canManage} saving={busyKey(r.strategyId, "cut2")} initial={pctDisplay(r.cut2Percent)} onSave={(v) => editStrategy(r, "cut2", { cut2Percent: v })} />,
      },
      {
        key: "clock", label: "Clock", kind: "money", width: BASE_WIDTHS.clock, accessor: (r) => r.clockAdjustment,
        render: (r) => <NumCell text={dec(r.clockAdjustment || 0).isZero() ? "" : formatMoney(r.clockAdjustment)} canManage={canManage} saving={busyKey(r.strategyId, "clock")} initial={dec(r.clockAdjustment || 0).toString()} onSave={(v) => editStrategy(r, "clock", { clockAdjustment: v })} />,
      },
      {
        key: "adjustments", label: "Adjustments", kind: "money", width: BASE_WIDTHS.adjustments, accessor: (r) => r.otherAdjustment,
        render: (r) => <NumCell text={dec(r.otherAdjustment || 0).isZero() ? "" : formatMoney(r.otherAdjustment)} canManage={canManage} saving={busyKey(r.strategyId, "adj")} initial={dec(r.otherAdjustment || 0).toString()} onSave={(v) => editStrategy(r, "adj", { otherAdjustment: v })} />,
      },
    ];

    const programCols: ColumnDef<MasserSheetRow>[] = data.programs.map((p) => ({
      key: `prog:${p.id}`, label: p.code, kind: "hours", width: PROG_W, programId: p.id,
      accessor: (r) => r.hours[p.id] ?? null,
      render: (r) => {
        const h = r.hours[p.id];
        return <NumCell text={h && !dec(h).isZero() ? dec(h).toDecimalPlaces(2).toString() : ""} canManage={canManage} saving={busyKey(r.strategyId, `prog:${p.id}`)} initial={h ? dec(h).toString() : ""} onSave={(v) => editStrategy(r, `prog:${p.id}`, { hours: { [p.id]: v === "" ? null : v } })} />;
      },
    }));

    const computed: ColumnDef<MasserSheetRow>[] = [
      { key: "yearlyGross", label: "Annual employee base", kind: "computed", width: BASE_WIDTHS.yearlyGross, accessor: (r) => r.yearlyGross, render: (r) => <span className="block px-2 py-1">{formatMoney(r.yearlyGross)}</span> },
      { key: "monthlyGross", label: "Monthly employee base", kind: "computed", width: BASE_WIDTHS.monthlyGross, accessor: (r) => r.monthlyGross, render: (r) => <span className="block px-2 py-1">{formatMoney(r.monthlyGross)}</span> },
      { key: "grossNet", label: "After deductions", kind: "computed", width: BASE_WIDTHS.grossNet, accessor: (r) => r.grossNet, render: (r) => <span className="block px-2 py-1">{formatMoney(r.grossNet)}</span> },
      { key: "net", label: "Net plan amount", kind: "computed", width: BASE_WIDTHS.net, accessor: (r) => r.net, render: (r) => <span className="block px-2 py-1 font-medium">{formatMoney(r.net)}</span> },
      {
        key: "masser", label: "Annual set-aside", kind: "money", width: BASE_WIDTHS.masser, accessor: (r) => r.masser,
        render: (r) => <NumCell text={r.masser ? formatMoney(r.masser) : ""} strong warn canManage={canManage} saving={busyKey(r.strategyId, "masser")} initial={r.masser ? dec(r.masser).toString() : ""} onSave={(v) => editStrategy(r, "masser", { afterAll: v === "" ? null : v })} />,
      },
      {
        key: "notes", label: "Notes", kind: "text", width: BASE_WIDTHS.notes, accessor: (r) => r.notes,
        render: (r) => <NotesCell row={r} canManage={canManage} saving={busyKey(r.individualId, "notes")} onSave={(v) => editIndividual(r, "notes", v)} />,
      },
    ];

    return [...base, ...programCols, ...computed];
  }, [data.programs, accountOptions, canManage, editStrategy, editIndividual, addAccountOption, busyKey]);

  const grid = useGrid<MasserSheetRow, Totals>({
    rows, columns, gridKey: "masser", canManage,
    initialSort: [{ key: "individual", dir: "asc" }],
    initialWidths: { ...BASE_WIDTHS, ...Object.fromEntries(data.programs.map((p) => [`prog:${p.id}`, PROG_W])) },
    searchKeys: ["individual", "account", "phone", "notes"],
    serializeHidden: true, serializeWidths: true,
    computeTotals: (f) => {
      let y = dec(0), m = dec(0), gn = dec(0), n = dec(0), ma = dec(0);
      for (const r of f) { y = y.plus(dec(r.yearlyGross || 0)); m = m.plus(dec(r.monthlyGross || 0)); gn = gn.plus(dec(r.grossNet || 0)); n = n.plus(dec(r.net || 0)); if (r.masser) ma = ma.plus(dec(r.masser)); }
      return { yearlyGross: y.toFixed(2), monthlyGross: m.toFixed(2), grossNet: gn.toFixed(2), net: n.toFixed(2), masser: ma.toFixed(2) };
    },
  });

  const { visibleColumns, sorted, widths } = grid;
  const colW = (c: ColumnDef<MasserSheetRow>) => widths[c.key] ?? c.width ?? 100;
  const totals = grid.totals;

  const frozenLeft = useMemo(() => {
    const map: Record<string, number> = {}; let left = 0;
    for (const c of visibleColumns) { if (!c.frozen) break; map[c.key] = left; left += widths[c.key] ?? c.width ?? 100; }
    return map;
  }, [visibleColumns, widths]);

  const setWidth = grid.setWidth;
  const dragRef = useRef<{ key: string; startX: number; startW: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => { const d = dragRef.current; if (d) setWidth(d.key, Math.max(56, d.startW + (e.clientX - d.startX))); };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [setWidth]);

  const tableWidth = visibleColumns.reduce((s, c) => s + colW(c), 0);
  const footVal: Record<string, string | undefined> = totals ? {
    individual: `Total · ${sorted.length}`, yearlyGross: formatMoney(totals.yearlyGross), monthlyGross: formatMoney(totals.monthlyGross),
    grossNet: formatMoney(totals.grossNet), net: formatMoney(totals.net), masser: formatMoney(totals.masser),
  } : {};

  return (
    <div className="space-y-3">
      <Toolbar
        grid={grid}
        searchPlaceholder="Search a person, account or note…"
        exportEndpoint="/api/grid/export"
        exportTitle="Annual plan matrix"
        exportFilename="annual-plans"
        showColumnChooser
        extraActions={canManage ? (
          <span className="ml-auto inline-flex items-center gap-2">
            <button type="button" onClick={() => setOptsOpen(true)} className="btn btn-sm btn-secondary"><Settings2 className="h-4 w-4" aria-hidden />Account options</button>
            <button type="button" onClick={() => setAddOpen(true)} className="btn btn-sm btn-primary"><Plus className="h-4 w-4" aria-hidden />Add budget</button>
          </span>
        ) : null}
      />

      <FilterBar grid={grid} />

      {notice ? <div className="rounded border border-[var(--color-danger)] bg-[#fdf2f5] px-3 py-1.5 text-sm text-[var(--color-danger)]">{notice}</div> : null}

      <p className="text-xs font-medium text-[var(--color-text-soft)]">Advanced plan editor · one row per annual plan</p>

      <div className="scroll-thin relative max-h-[66vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]">
        <table className="border-collapse text-sm" style={{ tableLayout: "fixed", width: tableWidth }}>
          <colgroup>{visibleColumns.map((c) => <col key={c.key} style={{ width: colW(c) }} />)}</colgroup>
          <thead className="sticky top-0 z-20">
            <tr>
              {visibleColumns.map((c) => {
                const s = grid.sort.find((x) => x.key === c.key);
                const isFrozen = c.key in frozenLeft;
                const numeric = isNumericKind(c.kind);
                const prog = c.key.startsWith("prog:") ? data.programs.find((p) => `prog:${p.id}` === c.key) : null;
                return (
                  <th key={c.key} aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : "none"}
                    className={`relative border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 align-bottom font-semibold ${numeric ? "text-right" : "text-left"}`}
                    style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 30 } : undefined}>
                    <div className={`flex items-center gap-1 ${numeric ? "flex-row-reverse" : ""}`}>
                      <span className="flex-1 whitespace-normal break-words leading-tight">{c.label}{prog ? <span className="block text-[10px] font-normal text-[var(--color-text-soft)]">{formatMoney(prog.rate)}</span> : null}</span>
                      <SortMenu label={c.label} numeric={numeric} dir={s ? s.dir : null} onSort={(dir) => grid.sortColumn(c.key, dir)} />
                      <HeaderFilter grid={grid} col={c} />
                    </div>
                    <span onMouseDown={(e) => { e.preventDefault(); dragRef.current = { key: c.key, startX: e.clientX, startW: colW(c) }; }} title="Drag to resize" className="absolute right-0 top-0 h-full w-2 cursor-col-resize select-none border-r-2 border-transparent hover:border-[var(--color-primary)]" />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.strategyId} className="hover:bg-black/[0.02]">
                {visibleColumns.map((c) => {
                  const isFrozen = c.key in frozenLeft;
                  const numeric = isNumericKind(c.kind);
                  return (
                    <td key={c.key}
                      className={`overflow-hidden border-b border-r border-[var(--color-rule)] px-0 align-top ${numeric ? "text-right tabular-nums" : "text-left"} ${c.kind === "computed" ? "bg-[var(--color-surface-muted)] text-[var(--color-ink-soft)]" : ""}`}
                      style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 10, background: "var(--color-surface)" } : undefined}>
                      {c.render ? c.render(r, c.accessor(r) ?? "", { editing: false, canManage }) : <span className="px-2">{c.accessor(r) ?? ""}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
            {sorted.length === 0 ? (
              <tr><td colSpan={visibleColumns.length} className="px-3 py-10 text-center text-[var(--color-text-soft)]">
                {rows.length === 0 ? "No budgets yet — use “Add budget” to start one." : "No one matches the current filters."}
              </td></tr>
            ) : null}
          </tbody>
          {sorted.length > 0 && totals ? (
            <tfoot className="sticky bottom-0 z-20">
              <tr className="border-t-2 border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] font-semibold">
                {visibleColumns.map((c) => {
                  const isFrozen = c.key in frozenLeft;
                  const numeric = isNumericKind(c.kind);
                  return (
                    <td key={c.key}
                      className={`border-r border-[var(--color-rule)] px-2 py-1.5 ${numeric ? "text-right tabular-nums" : "text-left"} ${c.key === "masser" ? "text-[var(--color-warn)]" : ""}`}
                      style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 10, background: "var(--color-surface-strong)" } : undefined}>
                      {footVal[c.key] ?? ""}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {addOpen ? <AddBudgetModal candidates={data.candidates} onClose={() => setAddOpen(false)} onDone={() => { setAddOpen(false); router.refresh(); }} /> : null}
      {optsOpen ? <AccountOptionsModal options={accountOptions} onClose={() => setOptsOpen(false)} onSaved={(o) => { setAccountOptions(o); setOptsOpen(false); }} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ cells */

/** An editable numeric/percent/money/hours cell: shows a value, becomes an input on click. */
function NumCell({ text, initial, canManage, saving, onSave, strong, warn }: {
  text: string; initial: string; canManage: boolean; saving: boolean; onSave: (v: string) => void; strong?: boolean; warn?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    const commit = (v: string) => { setEditing(false); onSave(v.trim()); };
    return (
      <input autoFocus type="number" step="any" defaultValue={initial}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit((e.target as HTMLInputElement).value); } else if (e.key === "Escape") { e.preventDefault(); setEditing(false); } }}
        onBlur={(e) => commit(e.target.value)}
        className="w-full rounded-none border border-[var(--color-primary)] bg-white px-2 py-1 text-right tabular-nums outline-none" />
    );
  }
  return (
    <button type="button" disabled={!canManage} onClick={() => canManage && setEditing(true)}
      className={`block w-full px-2 py-1 text-right ${canManage ? "cursor-cell hover:bg-[var(--color-primary-tint)]/50" : ""} ${strong ? "font-medium" : ""} ${warn ? "text-[var(--color-warn)]" : ""}`}>
      {text || (canManage ? <span className="text-[var(--color-text-soft)]">—</span> : "")}{saving ? <span className="ml-1 text-[10px] text-[var(--color-text-soft)]">…</span> : null}
    </button>
  );
}

/** The account dropdown: a select of the managed options + inline "add new". */
function AccountCell({ row, options, canManage, saving, onPick, onAddOption }: {
  row: MasserSheetRow; options: string[]; canManage: boolean; saving: boolean; onPick: (v: string | null) => void; onAddOption: (o: string) => Promise<boolean>;
}) {
  if (!canManage) {
    return <div className="px-2 py-1">{row.account ? <span className="rounded bg-[var(--color-primary-tint)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-primary)]">{row.account}</span> : <span className="text-[var(--color-text-soft)]">—</span>}</div>;
  }
  return (
    <div className="px-1 py-0.5">
      <select
        value={row.account ?? ""}
        onChange={async (e) => {
          const v = e.target.value;
          if (v === "__add__") {
            const label = window.prompt("New account option:")?.trim();
            if (label) { const ok = await onAddOption(label); if (ok) onPick(label); }
            return;
          }
          onPick(v === "" ? null : v);
        }}
        className="w-full rounded border border-transparent bg-transparent px-1 py-1 text-xs hover:border-[var(--color-rule-strong)] focus:border-[var(--color-primary)] focus:bg-white"
        title="Account tag">
        <option value="">—</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        {row.account && !options.includes(row.account) ? <option value={row.account}>{row.account}</option> : null}
        <option value="__add__">＋ New option…</option>
      </select>
      {saving ? <span className="ml-1 text-[10px] text-[var(--color-text-soft)]">…</span> : null}
    </div>
  );
}

/** The phone cell: a phone icon + an editable tel field. */
function PhoneCell({ row, canManage, saving, onSave }: { row: MasserSheetRow; canManage: boolean; saving: boolean; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    const commit = (v: string) => { setEditing(false); const t = v.trim(); onSave(t === "" ? null : t); };
    return (
      <div className="flex items-center gap-1 px-1 py-0.5">
        <Phone className="h-3 w-3 shrink-0 text-[var(--color-ink-faint)]" aria-hidden />
        <input autoFocus type="tel" defaultValue={row.phone ?? ""} placeholder="Phone…"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit((e.target as HTMLInputElement).value); } else if (e.key === "Escape") { e.preventDefault(); setEditing(false); } }}
          onBlur={(e) => commit(e.target.value)}
          className="w-full rounded border border-[var(--color-primary)] bg-white px-1 py-0.5 text-sm outline-none" />
      </div>
    );
  }
  return (
    <button type="button" disabled={!canManage} onClick={() => canManage && setEditing(true)}
      className={`flex w-full items-center gap-1 px-2 py-1 text-left ${canManage ? "cursor-text hover:bg-[var(--color-primary-tint)]/50" : ""}`} title={canManage ? "Click to edit" : undefined}>
      <Phone className="h-3 w-3 shrink-0 text-[var(--color-ink-faint)]" aria-hidden />
      {row.phone ? <a href={`tel:${row.phone}`} className="tnum truncate hover:underline" onClick={(e) => e.stopPropagation()}>{row.phone}</a> : <span className="text-[var(--color-text-soft)]">{canManage ? "add…" : "—"}</span>}
      {saving ? <span className="text-[10px] text-[var(--color-text-soft)]">…</span> : null}
    </button>
  );
}

function NotesCell({ row, canManage, saving, onSave }: { row: MasserSheetRow; canManage: boolean; saving: boolean; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    const commit = (v: string) => { setEditing(false); const t = v.trim(); onSave(t === "" ? null : t); };
    return (
      <textarea autoFocus defaultValue={row.notes ?? ""} rows={2} placeholder="Notes…"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit((e.target as HTMLTextAreaElement).value); } else if (e.key === "Escape") { e.preventDefault(); setEditing(false); } }}
        onBlur={(e) => commit(e.target.value)}
        className="w-full rounded-none border border-[var(--color-primary)] bg-white px-2 py-1 text-xs outline-none" />
    );
  }
  return (
    <button type="button" disabled={!canManage} onClick={() => canManage && setEditing(true)}
      className={`block w-full px-2 py-1 text-left text-xs text-[var(--color-ink-soft)] ${canManage ? "cursor-text hover:bg-[var(--color-primary-tint)]/50" : ""}`} title={canManage ? (row.notes ?? "Click to add a note") : row.notes ?? undefined}>
      {row.notes ? <span className="line-clamp-2 whitespace-pre-wrap">{row.notes}</span> : <span className="text-[var(--color-text-soft)]">{canManage ? "add a note…" : "—"}</span>}
      {saving ? <span className="ml-1 text-[10px] text-[var(--color-text-soft)]">…</span> : null}
    </button>
  );
}

/* ------------------------------------------------------------- add budget */

function AddBudgetModal({ candidates, onClose, onDone }: { candidates: BudgetCandidate[]; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newRenewal, setNewRenewal] = useState("");

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (n ? candidates.filter((c) => c.name.toLowerCase().includes(n)) : candidates).slice(0, 40);
  }, [q, candidates]);

  const addExisting = async (c: BudgetCandidate) => {
    setBusy(c.id); setErr(null);
    try {
      const res = await fetch("/api/calculation-strategies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ individualId: c.id }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not add the budget.");
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not add the budget."); setBusy(null); }
  };

  const createNew = async () => {
    const name = newName.trim();
    if (!name) { setErr("Enter a name for the new person."); return; }
    setBusy("new"); setErr(null);
    try {
      const res = await fetch("/api/individuals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: name, ...(newRenewal ? { renewalDate: newRenewal } : {}) }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not create the person.");
      if (!newRenewal && j.data?.id) {
        await fetch("/api/calculation-strategies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ individualId: j.data.id }) });
      }
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not create the person."); setBusy(null); }
  };

  return (
    <Modal title="Add a budget" onClose={onClose}>
      <div className="space-y-4">
        {err ? <p className="rounded border border-[var(--color-danger)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-danger)]">{err}</p> : null}
        <div>
          <p className="mb-1 text-sm font-medium">From someone already in your transactions</p>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a person…" className="input w-full" autoFocus />
          <div className="scroll-thin mt-2 max-h-64 overflow-auto rounded-lg border border-[var(--color-rule)]">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-[var(--color-text-soft)]">{candidates.length === 0 ? "Everyone already has a budget." : "No match."}</p>
            ) : filtered.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 border-b border-[var(--color-rule)] px-3 py-2 last:border-0">
                <div className="min-w-0"><div className="truncate text-sm font-medium">{c.name}</div><div className="text-xs text-[var(--color-text-soft)]">{c.txCount.toLocaleString()} transaction{c.txCount === 1 ? "" : "s"} · {formatMoney(c.billed)} billed</div></div>
                <button type="button" disabled={!!busy} onClick={() => addExisting(c)} className="btn btn-sm btn-secondary shrink-0">{busy === c.id ? "Adding…" : "Add budget"}</button>
              </div>
            ))}
          </div>
        </div>
        <div className="border-t border-[var(--color-rule)] pt-3">
          <p className="mb-1 text-sm font-medium">Or create a new person</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block flex-1 text-sm"><span className="text-xs text-[var(--color-ink-soft)]">Name</span><input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Full name" className="input mt-1 w-full" /></label>
            <label className="block text-sm"><span className="text-xs text-[var(--color-ink-soft)]">Renewal date (optional)</span><input type="date" value={newRenewal} onChange={(e) => setNewRenewal(e.target.value)} className="input mt-1" /></label>
            <button type="button" disabled={!!busy} onClick={createNew} className="btn btn-sm btn-primary">{busy === "new" ? "Creating…" : "Create + budget"}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------- account options */

function AccountOptionsModal({ options, onClose, onSaved }: { options: string[]; onClose: () => void; onSaved: (o: string[]) => void }) {
  const [list, setList] = useState<string[]>(options);
  const [add, setAdd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/masser/account-options", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ options: list }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save.");
      onSaved(Array.isArray(j.data) ? j.data : list);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save."); setBusy(false); }
  };

  return (
    <Modal title="Account options" onClose={onClose}>
      <div className="space-y-3">
        {err ? <p className="rounded border border-[var(--color-danger)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-danger)]">{err}</p> : null}
        <p className="text-sm text-[var(--color-ink-soft)]">The choices shown in the Account dropdown. Add your own; edit or remove any.</p>
        <div className="scroll-thin max-h-64 space-y-1 overflow-auto">
          {list.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={o} onChange={(e) => setList((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))} className="input flex-1 text-sm" />
              <button type="button" onClick={() => setList((prev) => prev.filter((_, j) => j !== i))} className="rounded px-2 py-1 text-sm text-[var(--color-ink-faint)] hover:text-[var(--color-danger)]" aria-label="Remove">✕</button>
            </div>
          ))}
          {list.length === 0 ? <p className="px-1 py-2 text-sm text-[var(--color-text-soft)]">No options yet.</p> : null}
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--color-rule)] pt-2">
          <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Add an option" className="input flex-1 text-sm"
            onKeyDown={(e) => { if (e.key === "Enter" && add.trim()) { setList((p) => [...p, add.trim()]); setAdd(""); } }} />
          <button type="button" disabled={!add.trim()} onClick={() => { setList((p) => [...p, add.trim()]); setAdd(""); }} className="btn btn-sm btn-secondary">Add</button>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="button" disabled={busy} onClick={save} className="btn btn-sm btn-primary">{busy ? "Saving…" : "Save options"}</button>
        </div>
      </div>
    </Modal>
  );
}
