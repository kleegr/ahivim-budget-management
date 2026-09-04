"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutList, RefreshCw, TableProperties } from "lucide-react";
import { dec, formatMoney, formatHours } from "@/lib/money";
import type { StrategyGridRow, ProgramRate } from "@/lib/manage/calculation-strategies";
import { type ColumnDef, type GridFieldKind, isNumericKind } from "@/components/data-grid/types";
import { formatCell, rawValue } from "@/components/data-grid/engine";
import { useGrid } from "@/components/data-grid/use-grid";
import { Toolbar } from "@/components/data-grid/toolbar";
import { FilterBar, HeaderFilter } from "@/components/data-grid/filter-bar";
import { friendlyActionError } from "@/lib/nav/review-actions";
import {
  selectedFinancialSetups,
  summarizeFinancialSetups,
} from "@/components/calculations/financial-setup-summary";

/**
 * The Calculations workspace on top of the shared data-grid engine. The engine
 * owns filtering, sorting, search, saved views and export; the Toolbar and
 * FilterBar own their UI. Everything that makes this grid special — inline cell
 * editing, Excel-style multi-cell selection + copy/paste, the Explain drawer,
 * the analytics-columns toggle and the add/duplicate/archive actions — still
 * lives here, and only points at `grid.sorted` / `grid.visibleColumns`.
 */

/* ------------------------------------------------------------------ types */

interface CalcTotals {
  yearly: string;
  monthly: string;
  net: string;
  approved: string;
  strategies: number;
  individuals: number;
}

interface ExplainStep {
  key: string;
  label: string;
  formula: string;
  value: string;
}
interface ExplainResult {
  yearlyGross: string;
  monthlyGross: string;
  grossNet: string;
  net: string;
  afterAll: string | null;
  lineGross: { programLabel: string; programId?: string; hours: string; rate: string; gross: string; isOverride: boolean; defaultRate: string }[];
  steps: ExplainStep[];
}
interface Revision {
  id: string;
  revision: number;
  reason: string | null;
  createdAt: string;
}

/* ------------------------------------------------------- percent display */

function pctDisplay(fraction: string | null): string {
  if (!fraction) return "";
  const d = dec(fraction).times(100);
  return d.toDecimalPlaces(2).toString();
}

function pct100(frac: string | null | undefined): string | null {
  if (frac === null || frac === undefined || frac === "") return null;
  try {
    return dec(frac).times(100).toDecimalPlaces(0).toString();
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- financial view */

type FinancialSortKey =
  | "name"
  | "account"
  | "renews"
  | "yearly"
  | "monthly"
  | "cut1"
  | "cut2"
  | "calculated"
  | "approved"
  | "difference";

function percentLabel(fraction: string | null): string {
  if (fraction === null || fraction === "") return "Not set";
  return `${dec(fraction).times(100).toDecimalPlaces(2).toString()}%`;
}

function overrideDifference(row: StrategyGridRow) {
  return row.approvedDifference === null ? null : dec(row.approvedDifference);
}

function FinancialTotal({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2">
      <div className="eyebrow text-[var(--color-text-soft)]">{label}</div>
      <div className="tnum text-xl font-semibold leading-tight">{formatMoney(value)}</div>
      <div className="mt-0.5 text-xs text-[var(--color-text-soft)]">{detail}</div>
    </div>
  );
}

function FinancialSortHead({
  sortKey,
  activeKey,
  direction,
  onSort,
  children,
  align = "left",
}: {
  sortKey: FinancialSortKey;
  activeKey: FinancialSortKey;
  direction: "asc" | "desc";
  onSort: (key: FinancialSortKey) => void;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th className={`whitespace-nowrap border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 font-semibold ${align === "right" ? "text-right" : "text-left"}`}>
      <button type="button" onClick={() => onSort(sortKey)} className={`inline-flex items-center gap-1 hover:underline ${align === "right" ? "flex-row-reverse" : ""}`} title="Sort">
        {children}
        <span className="text-[10px] text-[var(--color-primary)]">{activeKey === sortKey ? (direction === "asc" ? "▲" : "▼") : "⇅"}</span>
      </button>
    </th>
  );
}

/** The workbook's standing setup, without actuals or budget-utilization data. */
function FinancialOverview({ rows, onOpen }: { rows: StrategyGridRow[]; onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const deferredQuery = useDeferredValue(q);
  const [sort, setSort] = useState<{ key: FinancialSortKey; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selectAllRef = useRef<HTMLInputElement>(null);

  // Showing/hiding archived history or refreshing the page must not leave stale
  // selections contributing to an approved monthly total.
  useEffect(() => {
    const currentIds = new Set(rows.filter((row) => row.status === "active").map((row) => row.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => currentIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [rows]);

  const visible = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((row) =>
          [row.individualName, row.account, row.label].some((value) => value?.toLowerCase().includes(needle)),
        )
      : rows.slice();
    const text = (value: string | null) => value ?? "";
    const money = (value: string | null) => dec(value ?? 0);
    const compare = (a: StrategyGridRow, b: StrategyGridRow): number => {
      let result = 0;
      switch (sort.key) {
        case "name": result = a.individualName.localeCompare(b.individualName); break;
        case "account": result = text(a.account ?? a.label).localeCompare(text(b.account ?? b.label)); break;
        case "renews": result = text(a.renewalDate ?? "9999").localeCompare(text(b.renewalDate ?? "9999")); break;
        case "yearly": result = money(a.yearlyGross).comparedTo(money(b.yearlyGross)); break;
        case "monthly": result = money(a.monthlyGross).comparedTo(money(b.monthlyGross)); break;
        case "cut1": result = money(a.cut1Percent).comparedTo(money(b.cut1Percent)); break;
        case "cut2": result = money(a.cut2Percent).comparedTo(money(b.cut2Percent)); break;
        case "calculated": result = money(a.net).comparedTo(money(b.net)); break;
        case "approved": result = money(a.afterAll).comparedTo(money(b.afterAll)); break;
        case "difference": result = money(overrideDifference(a)?.toString() ?? null).comparedTo(money(overrideDifference(b)?.toString() ?? null)); break;
      }
      if (result === 0) result = a.individualName.localeCompare(b.individualName);
      return sort.dir === "asc" ? result : -result;
    };
    return filtered.sort(compare);
  }, [deferredQuery, rows, sort]);

  const selectedRows = useMemo(
    () => selectedFinancialSetups(rows, selectedIds),
    [rows, selectedIds],
  );
  const selectionActive = selectedRows.length > 0;
  const totals = useMemo(
    () => summarizeFinancialSetups(selectionActive ? selectedRows : visible),
    [selectionActive, selectedRows, visible],
  );
  const selectableVisibleIds = useMemo(
    () => visible.filter((row) => row.status === "active").map((row) => row.id),
    [visible],
  );
  const allVisibleSelected = selectableVisibleIds.length > 0
    && selectableVisibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = selectableVisibleIds.some((id) => selectedIds.has(id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
    }
  }, [allVisibleSelected, someVisibleSelected]);

  const toggleRow = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) selectableVisibleIds.forEach((id) => next.delete(id));
      else selectableVisibleIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggle = (key: FinancialSortKey) => {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" || key === "account" || key === "renews" ? "asc" : "desc" },
    );
  };

  const totalDetail = selectionActive
    ? `${totals.activeCount} selected current setup${totals.activeCount === 1 ? "" : "s"}`
    : deferredQuery.trim()
      ? `${totals.activeCount} current matching setups`
      : `${totals.activeCount} current setups`;
  const sortProps = { activeKey: sort.key, direction: sort.dir, onSort: toggle };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <FinancialTotal label="Yearly gross" value={totals.yearly} detail={totalDetail} />
        <FinancialTotal label="Monthly gross" value={totals.monthly} detail="Divided by each setup's month divisor" />
        <FinancialTotal label="Calculated net" value={totals.calculated} detail="After sequential cuts and adjustments" />
        <FinancialTotal label="Approved final" value={totals.approved} detail={`${totals.approvedCount} monthly approved amounts`} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search individual or account"
          className="input w-72 max-w-full"
          aria-label="Search financial setup"
        />
        <span className="text-sm text-[var(--color-text-soft)]">
          Showing <span className="tnum font-semibold text-[var(--color-ink)]">{visible.length}</span> of <span className="tnum">{rows.length}</span>
        </span>
        {selectionActive ? (
          <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-sm font-medium text-[var(--color-primary)]">
            {selectedRows.length} selected · combined Approved Final {formatMoney(totals.approved)}
            <button type="button" onClick={() => setSelectedIds(new Set())} className="text-xs underline hover:no-underline">
              Clear
            </button>
          </span>
        ) : null}
      </div>

      <div className="scroll-thin max-h-[64vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="w-10 whitespace-nowrap border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 text-center font-semibold">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allVisibleSelected}
                  disabled={selectableVisibleIds.length === 0}
                  onChange={toggleVisible}
                  aria-label="Select all current matching financial setups"
                />
              </th>
              <FinancialSortHead sortKey="name" {...sortProps}>Individual</FinancialSortHead>
              <FinancialSortHead sortKey="account" {...sortProps}>Account / type</FinancialSortHead>
              <FinancialSortHead sortKey="renews" {...sortProps}>Renewal date</FinancialSortHead>
              <FinancialSortHead sortKey="yearly" align="right" {...sortProps}>Yearly gross</FinancialSortHead>
              <FinancialSortHead sortKey="monthly" align="right" {...sortProps}>Monthly basis</FinancialSortHead>
              <FinancialSortHead sortKey="cut1" align="right" {...sortProps}>First cut</FinancialSortHead>
              <FinancialSortHead sortKey="cut2" align="right" {...sortProps}>Second cut</FinancialSortHead>
              <FinancialSortHead sortKey="calculated" align="right" {...sortProps}>Calculated net</FinancialSortHead>
              <FinancialSortHead sortKey="approved" align="right" {...sortProps}>Approved final</FinancialSortHead>
              <FinancialSortHead sortKey="difference" align="right" {...sortProps}>Override difference</FinancialSortHead>
              <th className="whitespace-nowrap border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 text-left font-semibold">Open</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const difference = overrideDifference(row);
              return (
                <tr key={row.id} className={`border-b border-[var(--color-rule)] hover:bg-black/[0.02] ${row.status === "archived" ? "opacity-70" : ""}`}>
                  <td className="px-3 py-2 text-center">
                    {row.status === "active" ? (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(row.id)}
                        onChange={() => toggleRow(row.id)}
                        aria-label={`Select ${row.individualName} ${row.account ?? row.label}`}
                      />
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-medium">
                    <Link href={`/individuals/${row.individualId}`} className="text-[var(--color-primary)] hover:underline" title={`Open ${row.individualName}'s profile`}>
                      {row.individualName}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-[var(--color-ink)]">{row.account ?? row.label}</div>
                    {row.account ? <div className="text-xs text-[var(--color-text-soft)]">{row.label}</div> : <div className="text-xs text-[var(--color-text-soft)]">Account not set</div>}
                    {row.status === "archived" ? <div className="text-xs font-medium text-[var(--color-text-soft)]">Archived history</div> : null}
                    {row.notes ? <div className="max-w-64 truncate text-xs text-[var(--color-text-soft)]" title={row.notes}>{row.notes}</div> : null}
                  </td>
                  <td className="tnum px-3 py-2 text-[var(--color-ink-soft)]">{row.renewalDate ?? "Not set"}</td>
                  <td className="tnum px-3 py-2 text-right">{formatMoney(row.yearlyGross)}</td>
                  <td className="tnum px-3 py-2 text-right">
                    <div className="font-medium">{formatMoney(row.monthlyGross)}</div>
                    <div className="text-xs text-[var(--color-text-soft)]">÷ {dec(row.monthDivisor).toString()} months</div>
                  </td>
                  <td className="tnum px-3 py-2 text-right">{percentLabel(row.cut1Percent)}</td>
                  <td className="tnum px-3 py-2 text-right">
                    <div>{percentLabel(row.cut2Percent)}</div>
                    <div className="text-xs text-[var(--color-text-soft)]">after first cut</div>
                  </td>
                  <td className="tnum px-3 py-2 text-right font-medium">{formatMoney(row.net)}</td>
                  <td className="tnum px-3 py-2 text-right font-medium">{row.afterAll === null ? <span className="font-normal text-[var(--color-text-soft)]">Not set</span> : formatMoney(row.afterAll)}</td>
                  <td className="tnum px-3 py-2 text-right text-[var(--color-ink-soft)]" title="Approved final minus calculated net">
                    {difference === null ? "-" : `${difference.isPositive() ? "+" : ""}${formatMoney(difference)}`}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    <button type="button" onClick={() => onOpen(row.id)} className="text-[var(--color-primary)] hover:underline" title="Open the step-by-step calculation">
                      Explain
                    </button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-3 py-10 text-center text-[var(--color-text-soft)]">
                  {rows.length === 0 ? "No financial setups yet." : "No financial setup matches your search."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- component */

export default function CalculationsGrid({
  rows,
  programs,
  individuals,
  canManage,
}: {
  rows: StrategyGridRow[];
  programs: ProgramRate[];
  individuals: { id: string; name: string }[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState<"overview" | "full">("overview");
  const [showArchived, setShowArchived] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [editing, setEditing] = useState<{ rowId: string; colKey: string } | null>(null);
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  const [selEnd, setSelEnd] = useState<{ row: number; col: number } | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [addFor, setAddFor] = useState("");
  const archivedCount = useMemo(() => rows.filter((row) => row.status === "archived").length, [rows]);
  const displayedRows = useMemo(
    () => rows.filter((row) => row.status === "active" || showArchived),
    [rows, showArchived],
  );

  /* ---- edit commit (PATCH /api/calculation-strategies/[id] with col.patch) ---- */
  const commitEdit = useCallback(
    async (col: ColumnDef<StrategyGridRow>, r: StrategyGridRow, value: string) => {
      if (!col.patch) return;
      if (r.status !== "active") {
        setNotice("Restore this archived setup before editing it.");
        setEditing(null);
        return;
      }
      const current = rawValue(col, r);
      if (value === current) {
        setEditing(null);
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch(`/api/calculation-strategies/${r.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(col.patch(value)),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save.");
        router.refresh();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "Could not save the change.");
      } finally {
        setBusy(false);
        setEditing(null);
      }
    },
    [router],
  );

  /* ---- columns: same shape as before, now ColumnDef<StrategyGridRow>[] ---- */
  const columns = useMemo<ColumnDef<StrategyGridRow>[]>(() => {
    // Editable cell: an <EditCell> when the cell is being edited, else the value
    // (or an em-dash affordance for managers). Reuses the existing commit path.
    const editable = (c: Omit<ColumnDef<StrategyGridRow>, "render" | "editable">): ColumnDef<StrategyGridRow> => {
      const col: ColumnDef<StrategyGridRow> = { ...c, editable: true };
      col.render = (row, text, ctx) =>
        ctx.editing ? (
          <EditCell
            kind={col.kind}
            initial={rawValue(col, row)}
            onCommit={(v) => commitEdit(col, row, v)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <span className={col.accessor(row) ? "" : "text-[var(--color-text-soft)]"}>{text || (ctx.canManage ? "—" : "")}</span>
        );
      return col;
    };

    const base: ColumnDef<StrategyGridRow>[] = [
      {
        key: "individual",
        label: "Individual",
        kind: "text",
        frozen: true,
        accessor: (r) => r.individualName,
        render: (row) => (
          <Link
            href={`/individuals/${row.individualId}`}
            className="group inline-flex items-center gap-1 font-medium text-[var(--color-primary)] hover:underline"
            onClick={(e) => e.stopPropagation()}
            title={`Open ${row.individualName}`}
          >
            {row.individualName}
            <span className="opacity-0 transition-opacity group-hover:opacity-100">→</span>
          </Link>
        ),
      },
      editable({ key: "label", label: "Setup name", kind: "text", accessor: (r) => r.label, patch: (v) => ({ label: v }) }),
      editable({ key: "account", label: "Account / type", kind: "text", accessor: (r) => r.account, patch: (v) => ({ account: v || null }) }),
      { key: "status", label: "Status", kind: "badge", badgeLabels: { active: "Current", archived: "Archived" }, accessor: (r) => r.status },
      editable({ key: "notes", label: "Notes", kind: "text", accessor: (r) => r.notes ?? null, patch: (v) => ({ notes: v || null }) }),
      editable({ key: "renewalDate", label: "Renewal date", kind: "date", frozen: true, accessor: (r) => r.renewalDate, patch: (v) => ({ renewalDate: v || null }) }),
      editable({ key: "monthDivisor", label: "Monthly divisor", kind: "int", accessor: (r) => r.monthDivisor, patch: (v) => ({ monthDivisor: v }) }),
      editable({ key: "cut1Percent", label: "First cut %", kind: "percent", exportType: "text", accessor: (r) => pctDisplay(r.cut1Percent), patch: (v) => ({ cut1Percent: v }) }),
      editable({ key: "cut2Percent", label: "Second cut %", kind: "percent", exportType: "text", accessor: (r) => pctDisplay(r.cut2Percent), patch: (v) => ({ cut2Percent: v }) }),
      editable({ key: "clockAdjustment", label: "Clock", kind: "money", accessor: (r) => r.clockAdjustment, patch: (v) => ({ clockAdjustment: v }) }),
      editable({ key: "otherAdjustment", label: "Other adj.", kind: "money", accessor: (r) => r.otherAdjustment, patch: (v) => ({ otherAdjustment: v }) }),
    ];

    const programCols: ColumnDef<StrategyGridRow>[] = programs.map((p) =>
      editable({
        key: `prog:${p.id}`,
        label: p.code,
        kind: "hours",
        programId: p.id,
        accessor: (r) => r.hours[p.id] ?? null,
        patch: (v) => ({ hours: { [p.id]: v === "" ? null : v } }),
      }),
    );

    const computed: ColumnDef<StrategyGridRow>[] = [
      { key: "yearlyGross", label: "Yearly gross", kind: "computed", accessor: (r) => r.yearlyGross },
      { key: "monthlyGross", label: "Monthly basis", kind: "computed", accessor: (r) => r.monthlyGross },
      { key: "cut1Amount", label: "First cut amount", kind: "computed", accessor: (r) => r.cut1Amount },
      { key: "afterCut1", label: "After first cut", kind: "computed", accessor: (r) => r.afterCut1 },
      { key: "cut2Amount", label: "Second cut amount", kind: "computed", accessor: (r) => r.cut2Amount },
      { key: "grossNet", label: "After sequential cuts", kind: "computed", accessor: (r) => r.grossNet },
      { key: "net", label: "Calculated net", kind: "computed", accessor: (r) => r.net },
      editable({ key: "afterAll", label: "Approved final / month", kind: "money", accessor: (r) => r.afterAll, patch: (v) => ({ afterAll: v === "" ? null : v }) }),
      { key: "approvedDifference", label: "Approved − calculated", kind: "computed", accessor: (r) => r.approvedDifference },
    ];

    // Optional read-only analysis columns: actual-vs-plan, forecast, and the
    // workbook↔system parity check. Appended when "Show analysis" is on.
    const analytics: ColumnDef<StrategyGridRow>[] = showAnalytics
      ? [
          { key: "a_actualHours", label: "Billed hrs", kind: "hours", accessor: (r) => r.analytics?.actualHours ?? null },
          { key: "a_actualInternal", label: "Billed $", kind: "computed", accessor: (r) => r.analytics?.actualInternal ?? null },
          { key: "a_scheduledHours", label: "Planned hrs", kind: "hours", accessor: (r) => r.analytics?.scheduledHours ?? null },
          { key: "a_remainingHours", label: "Remaining hrs", kind: "hours", accessor: (r) => r.analytics?.remainingHours ?? null },
          { key: "a_utilization", label: "% used", kind: "percent", exportType: "text", accessor: (r) => pct100(r.analytics?.utilizationPercent) },
          { key: "a_projected", label: "Runs out ~", kind: "date", accessor: (r) => r.analytics?.projectedExhaustion ?? null },
          { key: "a_workbook", label: "Spreadsheet final", kind: "computed", accessor: (r) => r.analytics?.workbookValue ?? null },
          { key: "a_system", label: "System final", kind: "computed", accessor: (r) => r.analytics?.systemValue ?? null },
          { key: "a_diff", label: "Diff vs. spreadsheet", kind: "computed", accessor: (r) => r.analytics?.difference ?? null },
          { key: "a_flags", label: "Needs a look", kind: "text", accessor: (r) => (r.analytics?.warnings.length ? r.analytics.warnings.join(", ") : null) },
        ]
      : [];

    return [...base, ...programCols, ...computed, ...analytics];
  }, [programs, showAnalytics, commitEdit]);

  const grid = useGrid<StrategyGridRow, CalcTotals>({
    rows: displayedRows,
    columns,
    gridKey: "calculations",
    canManage,
    initialSort: [{ key: "individual", dir: "asc" }],
    searchKeys: ["individual", "label", "account"],
    computeTotals: (filtered) => {
      let yearly = dec(0),
        monthly = dec(0),
        net = dec(0),
        approved = dec(0);
      let strategies = 0;
      const inds = new Set<string>();
      for (const r of filtered) {
        if (r.status !== "active") continue;
        strategies++;
        yearly = yearly.plus(dec(r.yearlyGross || 0));
        monthly = monthly.plus(dec(r.monthlyGross || 0));
        net = net.plus(dec(r.net || 0));
        if (r.afterAll) approved = approved.plus(dec(r.afterAll));
        inds.add(r.individualId);
      }
      return {
        yearly: yearly.toFixed(2),
        monthly: monthly.toFixed(2),
        net: net.toFixed(2),
        approved: approved.toFixed(2),
        strategies,
        individuals: inds.size,
      };
    },
    serializeHidden: false,
    serializeWidths: false,
    exportAllColumns: true,
  });

  /* ---- multi-cell selection, copy & paste (Excel-style) ---- */
  const selBounds = useMemo(() => {
    if (!active) return null;
    const end = selEnd ?? active;
    return {
      r0: Math.min(active.row, end.row),
      r1: Math.max(active.row, end.row),
      c0: Math.min(active.col, end.col),
      c1: Math.max(active.col, end.col),
    };
  }, [active, selEnd]);

  const inSelection = (r: number, c: number) =>
    !!selBounds && r >= selBounds.r0 && r <= selBounds.r1 && c >= selBounds.c0 && c <= selBounds.c1;

  const mergePatch = (target: Record<string, unknown>, addition: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(addition)) {
      if (k === "hours" && target.hours) {
        target.hours = { ...(target.hours as Record<string, unknown>), ...(v as Record<string, unknown>) };
      } else {
        target[k] = v;
      }
    }
    return target;
  };

  const saveCells = useCallback(
    async (edits: { rowId: string; body: Record<string, unknown> }[]) => {
      if (edits.length === 0) return;
      setBusy(true);
      setNotice(null);
      try {
        const byRow = new Map<string, Record<string, unknown>>();
        for (const e of edits) byRow.set(e.rowId, mergePatch(byRow.get(e.rowId) ?? {}, e.body));
        for (const [rowId, body] of byRow) {
          const res = await fetch(`/api/calculation-strategies/${rowId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save pasted values.");
        }
        setNotice(`Updated ${byRow.size} row${byRow.size === 1 ? "" : "s"} from paste.`);
        router.refresh();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "Paste failed.");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const copySelection = useCallback(() => {
    if (!selBounds) return;
    const lines: string[] = [];
    for (let r = selBounds.r0; r <= selBounds.r1; r++) {
      const cells: string[] = [];
      for (let c = selBounds.c0; c <= selBounds.c1; c++) {
        const col = grid.visibleColumns[c];
        const row = grid.sorted[r];
        cells.push(col && row ? col.accessor(row) ?? "" : "");
      }
      lines.push(cells.join("\t"));
    }
    navigator.clipboard
      ?.writeText(lines.join("\n"))
      .then(() => setNotice(`Copied ${selBounds.r1 - selBounds.r0 + 1} × ${selBounds.c1 - selBounds.c0 + 1} cells.`))
      .catch(() => {});
  }, [selBounds, grid.sorted, grid.visibleColumns]);

  const pasteBlock = useCallback(
    (text: string) => {
      if (!canManage || !active) return;
      const matrix = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
      const edits: { rowId: string; body: Record<string, unknown> }[] = [];
      let skipped = 0;
      for (let di = 0; di < matrix.length; di++) {
        const row = grid.sorted[active.row + di];
        if (!row) break;
        if (row.status !== "active") {
          skipped += matrix[di]!.length;
          continue;
        }
        for (let dj = 0; dj < matrix[di]!.length; dj++) {
          const col = grid.visibleColumns[active.col + dj];
          if (!col) continue;
          if (!col.editable || !col.patch) {
            skipped++;
            continue;
          }
          edits.push({ rowId: row.id, body: col.patch(matrix[di]![dj]!.trim()) as Record<string, unknown> });
        }
      }
      if (edits.length === 0) {
        setNotice(skipped ? "Those cells are read-only — paste onto editable columns." : "Nothing to paste.");
        return;
      }
      saveCells(edits);
    },
    [canManage, active, grid.sorted, grid.visibleColumns, saveCells],
  );

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !active) return;
    const move = (dr: number, dc: number, extend: boolean) => {
      e.preventDefault();
      const nr = Math.min(Math.max(0, active.row + dr), grid.sorted.length - 1);
      const nc = Math.min(Math.max(0, active.col + dc), grid.visibleColumns.length - 1);
      if (extend) setSelEnd({ row: nr, col: nc });
      else {
        setActive({ row: nr, col: nc });
        setSelEnd(null);
      }
    };
    if (e.key === "ArrowDown") move(1, 0, e.shiftKey);
    else if (e.key === "ArrowUp") move(-1, 0, e.shiftKey);
    else if (e.key === "ArrowLeft") move(0, -1, e.shiftKey);
    else if (e.key === "ArrowRight") move(0, 1, e.shiftKey);
    else if (e.key === "Enter" || e.key === "F2") {
      const col = grid.visibleColumns[active.col];
      const row = grid.sorted[active.row];
      if (canManage && col?.editable && row?.status === "active") {
        e.preventDefault();
        setEditing({ rowId: row.id, colKey: col.key });
      }
    } else if (e.key === "Escape") setSelEnd(null);
    else if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      copySelection();
    }
  };

  const addStrategy = async () => {
    if (!addFor) return;
    setBusy(true);
    try {
      const res = await fetch("/api/calculation-strategies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ individualId: addFor }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not add strategy.");
      setAddFor("");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not add strategy.");
    } finally {
      setBusy(false);
    }
  };

  const rowAction = async (id: string, action: "duplicate" | "archive" | "restore") => {
    setBusy(true);
    try {
      const url = action === "duplicate" ? `/api/calculation-strategies/${id}/duplicate` : `/api/calculation-strategies/${id}/status`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: action === "archive"
          ? JSON.stringify({ status: "archived" })
          : action === "restore"
            ? JSON.stringify({ status: "active" })
            : "{}",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Action failed.");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  const moveViewTabFocus = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const nextView = event.key === "ArrowLeft" || event.key === "Home"
      ? "overview"
      : event.key === "ArrowRight" || event.key === "End"
        ? "full"
        : null;
    if (!nextView) return;
    event.preventDefault();
    setView(nextView);
    window.requestAnimationFrame(() => {
      document.getElementById(`financial-setup-${nextView}-tab`)?.focus();
    });
  };

  // Hardcoded frozen leading column(s): the loop stops at the first non-frozen
  // column, so `individual` is sticky (kept identical to the original grid).
  const frozenLeft = useMemo(() => {
    const map: Record<string, number> = {};
    let left = 0;
    const widths: Record<string, number> = { individual: 170, renewalDate: 130 };
    for (const c of grid.visibleColumns) {
      if (!c.frozen) break;
      map[c.key] = left;
      left += widths[c.key] ?? 140;
    }
    return map;
  }, [grid.visibleColumns]);

  const tile = "rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2";
  const totals = grid.totals;
  const drawerRow = drawerId ? rows.find((row) => row.id === drawerId) : undefined;
  const closeDrawer = useCallback(() => setDrawerId(null), []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
      <div className="segmented-control" role="tablist" aria-label="Financial setup views">
        <button
          id="financial-setup-overview-tab"
          type="button"
          onClick={() => setView("overview")}
          onKeyDown={moveViewTabFocus}
          role="tab"
          aria-selected={view === "overview"}
          aria-controls="financial-setup-panel"
          tabIndex={view === "overview" ? 0 : -1}
        >
          <LayoutList className="h-4 w-4" aria-hidden /> Expected monthly amounts
        </button>
        <button
          id="financial-setup-full-tab"
          type="button"
          onClick={() => setView("full")}
          onKeyDown={moveViewTabFocus}
          role="tab"
          aria-selected={view === "full"}
          aria-controls="financial-setup-panel"
          tabIndex={view === "full" ? 0 : -1}
        >
          <TableProperties className="h-4 w-4" aria-hidden /> Advanced editor
        </button>
      </div>
        {archivedCount > 0 ? (
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            aria-pressed={showArchived}
            onClick={() => setShowArchived((current) => !current)}
          >
            {showArchived ? "Hide archived history" : `Show archived history (${archivedCount})`}
          </button>
        ) : null}
      </div>

      <div
        id="financial-setup-panel"
        role="tabpanel"
        aria-labelledby={view === "overview" ? "financial-setup-overview-tab" : "financial-setup-full-tab"}
      >
      {view === "overview" ? (
        <FinancialOverview rows={displayedRows} onOpen={setDrawerId} />
      ) : (
      <>
      {/* shared toolbar: search, result count, reset, saved views, export + our extras */}
      <Toolbar
        grid={grid}
        searchPlaceholder="Search financial setup…"
        exportEndpoint="/api/calculations/export"
        exportTitle="Financial setup"
        exportFilename="financial-setup"
        showColumnChooser={false}
        extraActions={
          <>
            <button
              type="button"
              onClick={() => setShowAnalytics((s) => !s)}
              className={`btn btn-sm ${showAnalytics ? "btn-primary" : "btn-secondary"}`}
            >
              {showAnalytics ? "Hide analysis" : "Show analysis"}
            </button>
            {canManage && (
              <span className="ml-auto inline-flex items-center gap-1">
                <select value={addFor} onChange={(e) => setAddFor(e.target.value)} className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1.5">
                  <option value="">Add a setup for…</option>
                  {individuals.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
                <button type="button" onClick={addStrategy} disabled={busy || !addFor} className="btn btn-sm btn-primary disabled:opacity-50">Add</button>
              </span>
            )}
          </>
        }
      />

      {/* visible filter bar (pills + active chips) */}
      <FilterBar grid={grid} />

      {/* filter-aware totals */}
      {totals && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Yearly gross</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.yearly)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Monthly gross</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.monthly)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Calculated net</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.net)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Approved final</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.approved)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Setups</div><div className="text-lg font-semibold tabular-nums">{totals.strategies}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Individuals</div><div className="text-lg font-semibold tabular-nums">{totals.individuals}</div></div>
        </div>
      )}

      {notice && <div className="rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-1.5 text-sm">{notice}</div>}
      {!canManage && <div className="rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-soft)]">You have read-only access. Editing is available to managers.</div>}

      {/* Advanced editor grid. */}
      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        onPaste={(e) => {
          if (!canManage || !active) return;
          e.preventDefault();
          pasteBlock(e.clipboardData.getData("text/plain"));
        }}
        className="scroll-thin relative max-h-[64vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)] outline-none focus:ring-2 focus:ring-[var(--color-primary-soft)]"
      >
        <table className="border-collapse text-sm" style={{ tableLayout: "auto" }}>
          <thead className="sticky top-0 z-20">
            <tr>
              {grid.visibleColumns.map((c) => {
                const sortIdx = grid.sort.findIndex((s) => s.key === c.key);
                const s = grid.sort[sortIdx];
                const isFrozen = c.key in frozenLeft;
                return (
                  <th key={c.key} aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : "none"} className="relative whitespace-nowrap border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 text-left align-bottom font-semibold" style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 30, minWidth: c.key === "individual" ? 170 : 130 } : undefined}>
                    <div className="flex items-center gap-1">
                      <button type="button" className="flex-1 truncate text-left hover:underline" title="Sort (Shift-click to add a level)" onClick={(e) => grid.toggleSort(c.key, e.shiftKey)}>
                        {c.label}
                        {s && <span className="ml-1 text-[10px] text-[var(--color-primary)]">{s.dir === "asc" ? "▲" : "▼"}{grid.sort.length > 1 ? sortIdx + 1 : ""}</span>}
                      </button>
                      <HeaderFilter grid={grid} col={c} />
                    </div>
                  </th>
                );
              })}
              <th className="border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 text-left font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grid.sorted.map((r, ri) => (
              <tr key={r.id} className="hover:bg-black/[0.02]">
                {grid.visibleColumns.map((c, ci) => {
                  const isFrozen = c.key in frozenLeft;
                  const numeric = isNumericKind(c.kind);
                  const isEditing = editing?.rowId === r.id && editing?.colKey === c.key;
                  const canEdit = canManage && r.status === "active" && !!c.editable;
                  const isActive = active?.row === ri && active?.col === ci;
                  const selected = inSelection(ri, ci);
                  const frozenBg = isActive ? "var(--color-primary-tint)" : selected ? "var(--color-primary-soft)" : "white";
                  const text = formatCell(c, r);
                  return (
                    <td
                      key={c.key}
                      onClick={(e) => {
                        if (e.shiftKey && active) setSelEnd({ row: ri, col: ci });
                        else {
                          setActive({ row: ri, col: ci });
                          setSelEnd(null);
                        }
                        gridRef.current?.focus();
                      }}
                      onDoubleClick={() => canEdit && setEditing({ rowId: r.id, colKey: c.key })}
                      className={`relative whitespace-nowrap border-b border-r px-2 py-1 ${numeric ? "text-right tabular-nums" : "text-left"} ${canEdit ? "cursor-cell" : "cursor-default"} ${c.kind === "computed" ? "text-[var(--color-text-soft)]" : ""} ${isActive ? "border-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]" : "border-[var(--color-rule)]"} ${selected && !isActive ? "bg-[var(--color-primary-soft)]" : c.kind === "computed" ? "bg-[var(--color-surface-muted)]" : ""}`}
                      style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 10, background: frozenBg, minWidth: c.key === "individual" ? 170 : 130 } : undefined}
                      title={c.key === "renewalDate" && r.periodStart ? `Renewal cycle: ${r.periodStart} → ${r.periodEnd}` : undefined}
                    >
                      {c.render ? (
                        c.render(r, text, { editing: isEditing, canManage })
                      ) : (
                        <span className={c.accessor(r) ? "" : "text-[var(--color-text-soft)]"}>{text || (canEdit ? "—" : "")}</span>
                      )}
                    </td>
                  );
                })}
                <td className="whitespace-nowrap border-b border-[var(--color-rule)] px-2 py-1 text-xs">
                  <button type="button" className="touch-target inline-flex items-center px-1 text-[var(--color-primary)] hover:underline" onClick={() => setDrawerId(r.id)}>Explain</button>
                  {canManage && r.status === "active" ? (
                    <>
                      <span className="px-1 text-[var(--color-text-soft)]">·</span>
                      <button type="button" disabled={busy} aria-busy={busy} className="touch-target inline-flex items-center px-1 text-[var(--color-primary)] hover:underline disabled:opacity-50" onClick={() => rowAction(r.id, "duplicate")}>Duplicate</button>
                      <span className="px-1 text-[var(--color-text-soft)]">·</span>
                      <button type="button" disabled={busy} aria-busy={busy} className="touch-target inline-flex items-center px-1 text-[var(--color-text-soft)] hover:text-red-600 hover:underline disabled:opacity-50" onClick={() => { if (confirm(`Archive ${r.individualName} ${r.label}? It is kept in history, not deleted.`)) rowAction(r.id, "archive"); }}>Archive</button>
                    </>
                  ) : canManage ? (
                    <>
                      <span className="px-1 text-[var(--color-text-soft)]">·</span>
                      <button type="button" disabled={busy} aria-busy={busy} className="touch-target inline-flex items-center px-1 text-[var(--color-primary)] hover:underline disabled:opacity-50" onClick={() => rowAction(r.id, "restore")}>Restore</button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {grid.sorted.length === 0 && (
              <tr>
                <td colSpan={grid.visibleColumns.length + 1} className="px-3 py-10 text-center text-[var(--color-text-soft)]">No financial setups match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </>
      )}
      </div>

      {drawerId && (
        <ExplainDrawer
          strategyId={drawerId}
          row={drawerRow}
          canManage={canManage && drawerRow?.status === "active"}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------- edit cell */

function EditCell({ kind, initial, onCommit, onCancel }: { kind: GridFieldKind; initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type={kind === "date" ? "date" : kind === "text" ? "text" : "number"}
      step={kind === "hours" || kind === "money" || kind === "percent" ? "any" : undefined}
      defaultValue={initial}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onCommit((e.target as HTMLInputElement).value.trim()); }
        else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      onBlur={(e) => onCommit(e.target.value.trim())}
      className="w-full min-w-[70px] rounded border border-[var(--color-primary)] bg-white px-1 py-0.5 text-right tabular-nums outline-none"
    />
  );
}

/* -------------------------------------------------------------- drawer */

function ExplainDrawer({ strategyId, row, canManage, onClose }: { strategyId: string; row: StrategyGridRow | undefined; canManage: boolean; onClose: () => void }) {
  const router = useRouter();
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [data, setData] = useState<{ explain: ExplainResult; revisions: Revision[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingRate, setSavingRate] = useState<string | null>(null);
  const [failedRate, setFailedRate] = useState<{ programId: string; value: string } | null>(null);

  const load = useCallback(() => {
    setError(null);
    setFailedRate(null);
    return fetch(`/api/calculation-strategies/${strategyId}`)
      .then((r) => r.json())
      .then((j) => { if (j.ok) setData(j.data); else setError(j.error ?? "Could not load."); })
      .catch(() => setError("Could not load."));
  }, [strategyId]);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    setFailedRate(null);
    fetch(`/api/calculation-strategies/${strategyId}`)
      .then((r) => r.json())
      .then((j) => { if (live) { if (j.ok) setData(j.data); else setError(j.error ?? "Could not load."); } })
      .catch(() => live && setError("Could not load."));
    return () => { live = false; };
  }, [strategyId]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => previousFocus?.focus());
    };
  }, [onClose]);

  const saveRate = async (programId: string, value: string) => {
    setSavingRate(programId);
    setError(null);
    setFailedRate(null);
    try {
      const res = await fetch(`/api/calculation-strategies/${strategyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rateOverrides: { [programId]: value === "" ? null : value } }),
      });
      if (res.ok) {
        await load(); // refresh the drawer's own numbers
        router.refresh(); // refresh the grid's computed columns
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(friendlyActionError(body.error, "Could not save this rate. Try again."));
        setFailedRate({ programId, value });
      }
    } catch {
      setError("Could not reach the server. This rate was not saved.");
      setFailedRate({ programId, value });
    } finally {
      setSavingRate(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="drawer-in fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-auto border-l border-[var(--color-rule-strong)] bg-white shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-[var(--color-rule)] px-4 py-3">
        <div>
          <div className="eyebrow text-[var(--color-text-soft)]">Calculation</div>
          <div id={titleId} className="text-lg font-semibold">{row ? `${row.individualName} — ${row.label}` : "Financial setup"}</div>
          {row?.renewalDate && <div className="text-xs text-[var(--color-text-soft)]">Renewal date {row.renewalDate}</div>}
        </div>
        <button ref={closeButtonRef} type="button" onClick={onClose} className="btn btn-sm btn-icon btn-ghost text-lg" aria-label="Close calculation details" title="Close calculation details">×</button>
      </div>
      <div className="px-4 py-3 text-sm">
        {error ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2">
            <p className="min-w-0 flex-1 text-[var(--color-ink-soft)]">{friendlyActionError(error, "This calculation could not load. Try again.")}</p>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={savingRate !== null}
              onClick={() => failedRate ? void saveRate(failedRate.programId, failedRate.value) : void load()}
            >
              <RefreshCw aria-hidden className="h-4 w-4" /> {failedRate ? "Retry save" : "Try again"}
            </button>
          </div>
        ) : null}
        {!data && !error && <div role="status" className="text-[var(--color-text-soft)]">Loading…</div>}
        {data && (
          <>
            <div className="eyebrow mb-1 text-[var(--color-text-soft)]">Program rates — yearly gross = Σ (hours × rate)</div>
            <table className="mb-3 w-full text-xs">
              <thead>
                <tr className="text-[var(--color-text-soft)]">
                  <th className="py-0.5 text-left font-medium">Program</th>
                  <th className="py-0.5 text-right font-medium">Hours</th>
                  <th className="py-0.5 text-right font-medium">Rate /hr</th>
                  <th className="py-0.5 text-right font-medium">Gross</th>
                </tr>
              </thead>
              <tbody>
                {data.explain.lineGross.map((l, i) => (
                  <tr key={i} className="border-t border-[var(--color-rule)]">
                    <td className="py-1">{l.programLabel}</td>
                    <td className="py-1 text-right tabular-nums">{formatHours(l.hours)}</td>
                    <td className="py-1 text-right">
                      {canManage && l.programId ? (
                        <span className="inline-flex items-center justify-end gap-1">
                          <input
                            type="number"
                            step="any"
                            defaultValue={dec(l.rate).toString()}
                            disabled={savingRate === l.programId}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v !== dec(l.rate).toString()) saveRate(l.programId!, v);
                            }}
                            className="w-16 rounded border border-[var(--color-rule-strong)] px-1 py-0.5 text-right tabular-nums"
                            title={l.isOverride ? `Override. Default is ${formatMoney(l.defaultRate)}. Clear to use default.` : "Default rate. Type to override for this strategy."}
                          />
                          <span className={`rounded px-1 text-[10px] ${l.isOverride ? "bg-[var(--color-warn-soft)] text-[var(--color-warn)]" : "bg-[var(--color-surface-strong)] text-[var(--color-text-soft)]"}`}>
                            {l.isOverride ? "override" : "default"}
                          </span>
                        </span>
                      ) : (
                        <span className="tabular-nums">{formatMoney(l.rate)}{l.isOverride ? " *" : ""}</span>
                      )}
                    </td>
                    <td className="py-1 text-right tabular-nums font-medium">{formatMoney(l.gross)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canManage && (
              <p className="mb-3 text-[11px] text-[var(--color-text-soft)]">
                Type a rate to override it for this setup; clear the box to return to the program default. Changing a rate recalculates everything instantly.
              </p>
            )}
            <div className="space-y-1.5">
              {data.explain.steps.map((s) => (
                <div key={s.key} className="flex items-baseline justify-between gap-3 border-b border-[var(--color-rule)] py-1">
                  <div>
                    <div className="font-medium">{s.key === "after_all" ? "Approved final (entered)" : s.label}</div>
                    <div className="text-xs text-[var(--color-text-soft)]">{s.key === "after_all" ? "Monthly approved amount from the workbook" : s.formula}</div>
                  </div>
                  <div className="tabular-nums font-semibold">{s.value ? formatMoney(s.value) : "—"}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 space-y-1.5 border-t border-[var(--color-rule)] pt-3">
              <div className="eyebrow text-[var(--color-text-soft)]">Open</div>
              {row && <Link href={`/individuals/${row.individualId}`} className="block text-[var(--color-primary)] hover:underline">Individual profile →</Link>}
              {row && <Link href={`/transactions?individualId=${row.individualId}`} className="block text-[var(--color-primary)] hover:underline">Billed transactions →</Link>}
              <Link href={`/schedule`} className="block text-[var(--color-primary)] hover:underline">Schedule →</Link>
            </div>

            <div className="mt-4 border-t border-[var(--color-rule)] pt-3">
              <div className="eyebrow mb-1 text-[var(--color-text-soft)]">Change history ({data.revisions.length})</div>
              {data.revisions.length === 0 && <div className="text-xs text-[var(--color-text-soft)]">No edits yet.</div>}
              {data.revisions.map((rv) => (
                <div key={rv.id} className="flex justify-between py-0.5 text-xs">
                  <span>Revision {rv.revision}{rv.reason ? ` — ${rv.reason}` : ""}</span>
                  <span className="text-[var(--color-text-soft)]">{new Date(rv.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
