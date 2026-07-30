"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { dec, formatMoney, formatHours } from "@/lib/money";
import type { StrategyGridRow, ProgramRate } from "@/lib/manage/calculation-strategies";
import type { ExportFieldType } from "@/lib/export/tabular";

/* ------------------------------------------------------------------ types */

type FieldType = "text" | "money" | "hours" | "date" | "percent" | "computed";

interface ColDef {
  key: string;
  header: string;
  type: FieldType;
  editable: boolean;
  frozen?: boolean;
  programId?: string;
  get: (r: StrategyGridRow) => string | null;
  patch?: (v: string) => Record<string, unknown>; // body for PATCH
}

interface ColumnFilter {
  selected?: string[];
  contains?: string;
  min?: string;
  max?: string;
  from?: string;
  to?: string;
}
interface SortKey {
  key: string;
  dir: "asc" | "desc";
}
interface SavedView {
  id: string;
  name: string;
  config: unknown;
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
  lineGross: { programLabel: string; hours: string; rate: string; gross: string }[];
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

/* -------------------------------------------------------------- columns */

function buildColumns(programs: ProgramRate[]): ColDef[] {
  const base: ColDef[] = [
    { key: "individual", header: "Individual", type: "text", editable: false, frozen: true, get: (r) => r.individualName },
    { key: "label", header: "Line", type: "text", editable: true, get: (r) => r.label, patch: (v) => ({ label: v }) },
    { key: "renewalDate", header: "Renewal date", type: "date", editable: true, frozen: true, get: (r) => r.renewalDate, patch: (v) => ({ renewalDate: v || null }) },
    { key: "cut1Percent", header: "1st cut %", type: "percent", editable: true, get: (r) => pctDisplay(r.cut1Percent), patch: (v) => ({ cut1Percent: v }) },
    { key: "cut2Percent", header: "2nd cut %", type: "percent", editable: true, get: (r) => pctDisplay(r.cut2Percent), patch: (v) => ({ cut2Percent: v }) },
    { key: "clockAdjustment", header: "Clock", type: "money", editable: true, get: (r) => r.clockAdjustment, patch: (v) => ({ clockAdjustment: v }) },
    { key: "otherAdjustment", header: "Other adj.", type: "money", editable: true, get: (r) => r.otherAdjustment, patch: (v) => ({ otherAdjustment: v }) },
  ];
  const programCols: ColDef[] = programs.map((p) => ({
    key: `prog:${p.id}`,
    header: p.code,
    type: "hours",
    editable: true,
    programId: p.id,
    get: (r) => r.hours[p.id] ?? null,
    patch: (v) => ({ hours: { [p.id]: v === "" ? null : v } }),
  }));
  const computed: ColDef[] = [
    { key: "yearlyGross", header: "Yearly gross", type: "computed", editable: false, get: (r) => r.yearlyGross },
    { key: "monthlyGross", header: "Monthly gross", type: "computed", editable: false, get: (r) => r.monthlyGross },
    { key: "grossNet", header: "Gross net", type: "computed", editable: false, get: (r) => r.grossNet },
    { key: "net", header: "Net", type: "computed", editable: false, get: (r) => r.net },
    { key: "afterAll", header: "After All", type: "money", editable: true, get: (r) => r.afterAll, patch: (v) => ({ afterAll: v === "" ? null : v }) },
    { key: "account", header: "Account", type: "text", editable: true, get: (r) => r.account, patch: (v) => ({ account: v || null }) },
  ];
  return [...base, ...programCols, ...computed];
}

function pct100(frac: string | null | undefined): string | null {
  if (frac === null || frac === undefined || frac === "") return null;
  try {
    return dec(frac).times(100).toDecimalPlaces(0).toString();
  } catch {
    return null;
  }
}

// Optional read-only analysis columns: actual-vs-plan, forecast, and the
// workbook↔system parity check. Shown when the user toggles "Show analysis".
function buildAnalyticsColumns(): ColDef[] {
  return [
    { key: "a_actualHours", header: "Actual hrs", type: "hours", editable: false, get: (r) => r.analytics?.actualHours ?? null },
    { key: "a_actualInternal", header: "Actual $", type: "computed", editable: false, get: (r) => r.analytics?.actualInternal ?? null },
    { key: "a_scheduledHours", header: "Scheduled hrs", type: "hours", editable: false, get: (r) => r.analytics?.scheduledHours ?? null },
    { key: "a_remainingHours", header: "Remaining hrs", type: "hours", editable: false, get: (r) => r.analytics?.remainingHours ?? null },
    { key: "a_utilization", header: "Utilization", type: "percent", editable: false, get: (r) => pct100(r.analytics?.utilizationPercent) },
    { key: "a_projected", header: "Projected exhaustion", type: "date", editable: false, get: (r) => r.analytics?.projectedExhaustion ?? null },
    { key: "a_workbook", header: "Workbook (After All)", type: "computed", editable: false, get: (r) => r.analytics?.workbookValue ?? null },
    { key: "a_system", header: "System (Net)", type: "computed", editable: false, get: (r) => r.analytics?.systemValue ?? null },
    { key: "a_diff", header: "Δ (wb − sys)", type: "computed", editable: false, get: (r) => r.analytics?.difference ?? null },
    { key: "a_flags", header: "Flags", type: "text", editable: false, get: (r) => (r.analytics?.warnings.length ? r.analytics.warnings.join(", ") : null) },
  ];
}

const EXPORT_TYPE: Record<FieldType, ExportFieldType> = {
  text: "text", money: "money", hours: "hours", date: "date", percent: "text", computed: "money",
};
const NUMERIC: Set<FieldType> = new Set(["money", "hours", "percent", "computed"]);

function cellText(col: ColDef, r: StrategyGridRow): string {
  const v = col.get(r);
  if (v === null || v === undefined || v === "") return "";
  if (col.type === "money" || col.type === "computed") return formatMoney(v);
  if (col.type === "hours") return formatHours(v);
  if (col.type === "percent") return `${v}%`;
  return String(v);
}
function rawStr(col: ColDef, r: StrategyGridRow): string {
  const v = col.get(r);
  return v === null || v === undefined ? "" : String(v);
}
function numOf(col: ColDef, r: StrategyGridRow): number | null {
  const v = col.get(r);
  if (v === null || v === undefined || v === "") return null;
  try {
    return dec(v).toNumber();
  } catch {
    return null;
  }
}

function passes(col: ColDef, r: StrategyGridRow, f: ColumnFilter | undefined): boolean {
  if (!f) return true;
  if (NUMERIC.has(col.type)) {
    const n = numOf(col, r);
    if (f.min != null && f.min !== "" && (n === null || n < Number(f.min))) return false;
    if (f.max != null && f.max !== "" && (n === null || n > Number(f.max))) return false;
    return true;
  }
  if (col.type === "date") {
    const v = rawStr(col, r);
    if (f.from && (!v || v < f.from)) return false;
    if (f.to && (!v || v > f.to)) return false;
    return true;
  }
  const v = rawStr(col, r);
  if (f.selected && f.selected.length > 0 && !f.selected.includes(v)) return false;
  if (f.contains && !v.toLowerCase().includes(f.contains.toLowerCase())) return false;
  return true;
}
function filterActive(col: ColDef, f: ColumnFilter | undefined): boolean {
  if (!f) return false;
  if (NUMERIC.has(col.type)) return (f.min != null && f.min !== "") || (f.max != null && f.max !== "");
  if (col.type === "date") return Boolean(f.from || f.to);
  return Boolean((f.selected && f.selected.length > 0) || f.contains);
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
  const [showAnalytics, setShowAnalytics] = useState(false);
  const COLUMNS = useMemo(
    () => (showAnalytics ? [...buildColumns(programs), ...buildAnalyticsColumns()] : buildColumns(programs)),
    [programs, showAnalytics],
  );
  const colByKey = useMemo(() => new Map(COLUMNS.map((c) => [c.key, c])), [COLUMNS]);

  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  const [sort, setSort] = useState<SortKey[]>([{ key: "individual", dir: "asc" }]);
  const [search, setSearch] = useState("");
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ rowId: string; colKey: string } | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [addFor, setAddFor] = useState("");
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState("");

  useEffect(() => {
    fetch("/api/grid-views?grid=calculations")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.data && setViews(j.data as SavedView[]))
      .catch(() => {});
  }, []);

  const applyAll = useCallback(
    (exceptKey?: string) =>
      rows.filter((r) => {
        for (const col of COLUMNS) {
          if (col.key === exceptKey) continue;
          if (!passes(col, r, filters[col.key])) return false;
        }
        if (search.trim()) {
          const q = search.trim().toLowerCase();
          if (!r.individualName.toLowerCase().includes(q) && !r.label.toLowerCase().includes(q) && !(r.account ?? "").toLowerCase().includes(q)) return false;
        }
        return true;
      }),
    [rows, COLUMNS, filters, search],
  );

  const filtered = useMemo(() => applyAll(), [applyAll]);

  const sorted = useMemo(() => {
    if (sort.length === 0) return filtered;
    const arr = filtered.slice();
    arr.sort((a, b) => {
      for (const s of sort) {
        const col = colByKey.get(s.key);
        if (!col) continue;
        let cmp = 0;
        if (NUMERIC.has(col.type)) cmp = (numOf(col, a) ?? -Infinity) - (numOf(col, b) ?? -Infinity);
        else cmp = rawStr(col, a).localeCompare(rawStr(col, b), undefined, { numeric: true });
        if (cmp !== 0) return s.dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
    return arr;
  }, [filtered, sort, colByKey]);

  const totals = useMemo(() => {
    let yearly = dec(0), monthly = dec(0), net = dec(0), after = dec(0);
    const inds = new Set<string>();
    for (const r of filtered) {
      yearly = yearly.plus(dec(r.yearlyGross || 0));
      monthly = monthly.plus(dec(r.monthlyGross || 0));
      net = net.plus(dec(r.net || 0));
      if (r.afterAll) after = after.plus(dec(r.afterAll));
      inds.add(r.individualId);
    }
    return {
      yearly: yearly.toFixed(2),
      monthly: monthly.toFixed(2),
      net: net.toFixed(2),
      after: after.toFixed(2),
      strategies: filtered.length,
      individuals: inds.size,
    };
  }, [filtered]);

  const valueCounts = useMemo(() => {
    if (!openFilter) return [];
    const col = colByKey.get(openFilter);
    if (!col || NUMERIC.has(col.type) || col.type === "date") return [];
    const base = applyAll(openFilter);
    const counts = new Map<string, number>();
    for (const r of base) {
      const v = rawStr(col, r);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [openFilter, applyAll, colByKey]);

  /* ---- edit commit ---- */
  const commitEdit = useCallback(
    async (col: ColDef, r: StrategyGridRow, value: string) => {
      if (!col.patch) return;
      const current = rawStr(col, r);
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

  const toggleSort = (key: string, additive: boolean) => {
    setSort((prev) => {
      const existing = prev.find((s) => s.key === key);
      if (additive) {
        const others = prev.filter((s) => s.key !== key);
        if (existing && existing.dir === "desc") return others;
        return [...others, { key, dir: existing?.dir === "asc" ? "desc" : "asc" }];
      }
      if (existing) return existing.dir === "asc" ? [{ key, dir: "desc" }] : [];
      return [{ key, dir: "asc" }];
    });
  };

  const setFilter = (key: string, patch: Partial<ColumnFilter> | null) =>
    setFilters((prev) => {
      const next = { ...prev };
      if (patch === null) delete next[key];
      else next[key] = { ...prev[key], ...patch };
      return next;
    });

  const anyFilter = search.trim() !== "" || COLUMNS.some((c) => filterActive(c, filters[c.key]));
  const clearAll = () => {
    setFilters({});
    setSearch("");
    setSort([{ key: "individual", dir: "asc" }]);
  };

  const currentConfig = () => ({ filters, sort, search });
  const applyConfig = (cfg: { filters?: Record<string, ColumnFilter>; sort?: SortKey[]; search?: string }) => {
    setFilters(cfg.filters ?? {});
    setSort(cfg.sort ?? []);
    setSearch(cfg.search ?? "");
  };

  const saveView = async () => {
    const name = viewName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await fetch("/api/grid-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gridKey: "calculations", name, config: currentConfig() }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save view.");
      setViews((prev) => [...prev.filter((v) => v.name !== name), j.data as SavedView].sort((a, b) => a.name.localeCompare(b.name)));
      setViewName("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not save view.");
    } finally {
      setBusy(false);
    }
  };
  const deleteView = async (v: SavedView) => {
    await fetch(`/api/grid-views/${v.id}?grid=calculations`, { method: "DELETE" }).catch(() => {});
    setViews((prev) => prev.filter((x) => x.id !== v.id));
  };

  const exportView = async (format: "csv" | "xlsx") => {
    setBusy(true);
    try {
      const cols = COLUMNS.map((c) => ({ key: c.key, header: c.header, type: EXPORT_TYPE[c.type] }));
      const outRows = sorted.map((r) => {
        const o: Record<string, string | null> = {};
        for (const c of COLUMNS) o[c.key] = c.get(r);
        return o;
      });
      const res = await fetch("/api/calculations/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format, title: "Calculations", filename: "calculations", columns: cols, rows: outRows }),
      });
      if (!res.ok) throw new Error("Export failed.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `calculations-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(false);
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

  const rowAction = async (id: string, action: "duplicate" | "archive") => {
    setBusy(true);
    try {
      const url = action === "duplicate" ? `/api/calculation-strategies/${id}/duplicate` : `/api/calculation-strategies/${id}/status`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: action === "archive" ? JSON.stringify({ status: "archived" }) : "{}",
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

  const visibleCols = COLUMNS;
  const frozenLeft = useMemo(() => {
    const map: Record<string, number> = {};
    let left = 0;
    const widths: Record<string, number> = { individual: 170, renewalDate: 130 };
    for (const c of visibleCols) {
      if (!c.frozen) break;
      map[c.key] = left;
      left += widths[c.key] ?? 140;
    }
    return map;
  }, [visibleCols]);

  const tile = "rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2";

  return (
    <div className="space-y-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search individual, line, account…" className="min-w-[240px] flex-1 rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5" />
        <button type="button" onClick={() => setShowAnalytics((s) => !s)} className={`btn btn-sm ${showAnalytics ? "btn-primary" : "btn-secondary"}`}>
          {showAnalytics ? "Hide analysis" : "Show analysis"}
        </button>
        <button type="button" onClick={() => exportView("csv")} disabled={busy} className="rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 font-medium disabled:opacity-50">Export CSV</button>
        <button type="button" onClick={() => exportView("xlsx")} disabled={busy} className="rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 font-medium disabled:opacity-50">Export Excel</button>
        <button type="button" onClick={clearAll} disabled={!anyFilter} className="rounded border border-[var(--color-rule-strong)] bg-white px-3 py-1.5 font-medium disabled:opacity-40">Clear all filters</button>
        {canManage && (
          <span className="ml-auto inline-flex items-center gap-1">
            <select value={addFor} onChange={(e) => setAddFor(e.target.value)} className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1.5">
              <option value="">Add strategy for…</option>
              {individuals.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
            <button type="button" onClick={addStrategy} disabled={busy || !addFor} className="rounded bg-[var(--color-primary)] px-2.5 py-1.5 font-medium text-white disabled:opacity-50">Add</button>
          </span>
        )}
      </div>

      {/* saved views */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="eyebrow text-[var(--color-text-soft)]">Saved views</span>
        {views.length === 0 && <span className="text-[var(--color-text-soft)]">None yet</span>}
        {views.map((v) => (
          <span key={v.id} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-rule-strong)] bg-white px-2 py-0.5">
            <button type="button" className="font-medium hover:underline" onClick={() => applyConfig(v.config as { filters?: Record<string, ColumnFilter>; sort?: SortKey[]; search?: string })}>{v.name}</button>
            {canManage && <button type="button" aria-label={`Delete ${v.name}`} className="text-[var(--color-text-soft)] hover:text-red-600" onClick={() => deleteView(v)}>×</button>}
          </span>
        ))}
        {canManage && (
          <span className="ml-auto inline-flex items-center gap-1">
            <input value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Name this view" className="w-36 rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1" />
            <button type="button" onClick={saveView} disabled={busy || !viewName.trim()} className="rounded bg-[var(--color-primary)] px-2.5 py-1 font-medium text-white disabled:opacity-50">Save view</button>
          </span>
        )}
      </div>

      {notice && <div className="rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-1.5 text-sm">{notice}</div>}
      {!canManage && <div className="rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-soft)]">You have read-only access. Editing is available to managers.</div>}

      {/* grid */}
      <div className="relative max-h-[64vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]">
        <table className="border-collapse text-sm" style={{ tableLayout: "auto" }}>
          <thead className="sticky top-0 z-20">
            <tr>
              {visibleCols.map((c) => {
                const sortIdx = sort.findIndex((s) => s.key === c.key);
                const s = sort[sortIdx];
                const isFrozen = c.key in frozenLeft;
                const active = filterActive(c, filters[c.key]);
                return (
                  <th key={c.key} className="relative whitespace-nowrap border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 text-left align-bottom font-semibold" style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 30, minWidth: c.key === "individual" ? 170 : 130 } : undefined}>
                    <div className="flex items-center gap-1">
                      <button type="button" className="flex-1 truncate text-left hover:underline" title="Sort (Shift-click to add a level)" onClick={(e) => toggleSort(c.key, e.shiftKey)}>
                        {c.header}
                        {s && <span className="ml-1 text-[10px] text-[var(--color-primary)]">{s.dir === "asc" ? "▲" : "▼"}{sort.length > 1 ? sortIdx + 1 : ""}</span>}
                      </button>
                      <button type="button" aria-label={`Filter ${c.header}`} onClick={() => setOpenFilter((k) => (k === c.key ? null : c.key))} className={`shrink-0 rounded px-1 text-xs ${active ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-soft)] hover:bg-black/5"}`}>▾</button>
                    </div>
                    {openFilter === c.key && (
                      <FilterPopover col={c} filter={filters[c.key]} values={valueCounts} onChange={(p) => setFilter(c.key, p)} onClear={() => setFilter(c.key, null)} onClose={() => setOpenFilter(null)} />
                    )}
                  </th>
                );
              })}
              <th className="border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 text-left font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="hover:bg-black/[0.02]">
                {visibleCols.map((c) => {
                  const isFrozen = c.key in frozenLeft;
                  const numeric = NUMERIC.has(c.type);
                  const isEditing = editing?.rowId === r.id && editing?.colKey === c.key;
                  const canEdit = canManage && c.editable;
                  return (
                    <td
                      key={c.key}
                      onClick={() => canEdit && !isEditing && setEditing({ rowId: r.id, colKey: c.key })}
                      className={`whitespace-nowrap border-b border-r border-[var(--color-rule)] px-2 py-1 ${numeric ? "text-right tabular-nums" : "text-left"} ${canEdit ? "cursor-text" : ""} ${c.type === "computed" ? "bg-[var(--color-surface)] text-[var(--color-text-soft)]" : ""}`}
                      style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 10, background: "white", minWidth: c.key === "individual" ? 170 : 130 } : undefined}
                      title={c.key === "renewalDate" && r.periodStart ? `Budget period: ${r.periodStart} → ${r.periodEnd}` : undefined}
                    >
                      {c.key === "individual" ? (
                        <Link href={`/individuals/${r.individualId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{r.individualName}</Link>
                      ) : isEditing ? (
                        <EditCell
                          type={c.type}
                          initial={rawStr(c, r)}
                          onCommit={(v) => commitEdit(c, r, v)}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <span className={c.get(r) ? "" : "text-[var(--color-text-soft)]"}>{cellText(c, r) || (canEdit ? "—" : "")}</span>
                      )}
                    </td>
                  );
                })}
                <td className="whitespace-nowrap border-b border-[var(--color-rule)] px-2 py-1 text-xs">
                  <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => setDrawerId(r.id)}>Explain</button>
                  {canManage && (
                    <>
                      <span className="px-1 text-[var(--color-text-soft)]">·</span>
                      <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => rowAction(r.id, "duplicate")}>Duplicate</button>
                      <span className="px-1 text-[var(--color-text-soft)]">·</span>
                      <button type="button" className="text-[var(--color-text-soft)] hover:text-red-600 hover:underline" onClick={() => { if (confirm(`Archive ${r.individualName} ${r.label}? It is kept in history, not deleted.`)) rowAction(r.id, "archive"); }}>Archive</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={visibleCols.length + 1} className="px-3 py-10 text-center text-[var(--color-text-soft)]">No strategies match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* filter-aware totals */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Yearly gross</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.yearly)}</div></div>
        <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Monthly gross</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.monthly)}</div></div>
        <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Net (monthly)</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.net)}</div></div>
        <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">After All</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.after)}</div></div>
        <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]"># Strategies</div><div className="text-lg font-semibold tabular-nums">{totals.strategies}</div></div>
        <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]"># Individuals</div><div className="text-lg font-semibold tabular-nums">{totals.individuals}</div></div>
      </div>

      {drawerId && <ExplainDrawer strategyId={drawerId} row={rows.find((r) => r.id === drawerId)} onClose={() => setDrawerId(null)} />}
    </div>
  );
}

/* -------------------------------------------------------------- edit cell */

function EditCell({ type, initial, onCommit, onCancel }: { type: FieldType; initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type={type === "date" ? "date" : type === "text" ? "text" : "number"}
      step={type === "hours" || type === "money" || type === "percent" ? "any" : undefined}
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

/* -------------------------------------------------------------- popover */

function FilterPopover({ col, filter, values, onChange, onClear, onClose }: { col: ColDef; filter: ColumnFilter | undefined; values: [string, number][]; onChange: (p: Partial<ColumnFilter> | null) => void; onClear: () => void; onClose: () => void }) {
  const isNum = NUMERIC.has(col.type);
  const isDate = col.type === "date";
  const selected = new Set(filter?.selected ?? []);
  const [q, setQ] = useState(filter?.contains ?? "");
  const shown = q ? values.filter(([v]) => v.toLowerCase().includes(q.toLowerCase())) : values;
  return (
    <div className="absolute left-0 top-full z-40 mt-1 w-60 rounded-lg border border-[var(--color-rule-strong)] bg-white p-2 text-sm font-normal shadow-lg" onClick={(e) => e.stopPropagation()}>
      {isNum && (
        <div className="flex items-center gap-2">
          <input type="number" placeholder="Min" defaultValue={filter?.min ?? ""} onChange={(e) => onChange({ min: e.target.value })} className="w-full rounded border border-[var(--color-rule-strong)] px-2 py-1" />
          <input type="number" placeholder="Max" defaultValue={filter?.max ?? ""} onChange={(e) => onChange({ max: e.target.value })} className="w-full rounded border border-[var(--color-rule-strong)] px-2 py-1" />
        </div>
      )}
      {isDate && (
        <div className="space-y-2">
          <label className="block">From<input type="date" defaultValue={filter?.from ?? ""} onChange={(e) => onChange({ from: e.target.value })} className="mt-0.5 w-full rounded border border-[var(--color-rule-strong)] px-2 py-1" /></label>
          <label className="block">To<input type="date" defaultValue={filter?.to ?? ""} onChange={(e) => onChange({ to: e.target.value })} className="mt-0.5 w-full rounded border border-[var(--color-rule-strong)] px-2 py-1" /></label>
        </div>
      )}
      {!isNum && !isDate && (
        <div>
          <input value={q} onChange={(e) => { setQ(e.target.value); onChange({ contains: e.target.value }); }} placeholder="Contains…" className="mb-1 w-full rounded border border-[var(--color-rule-strong)] px-2 py-1" />
          <div className="mb-1 flex justify-between text-xs text-[var(--color-text-soft)]">
            <button type="button" className="underline" onClick={() => onChange({ selected: shown.map(([v]) => v) })}>Select all</button>
            <button type="button" className="underline" onClick={() => onChange({ selected: [] })}>Clear</button>
          </div>
          <div className="max-h-44 overflow-auto">
            {shown.map(([v, n]) => (
              <label key={v} className="flex items-center gap-1.5 px-1 py-0.5 hover:bg-black/5">
                <input type="checkbox" checked={selected.size === 0 ? false : selected.has(v)} onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(v); else next.delete(v); onChange({ selected: [...next] }); }} />
                <span className="flex-1 truncate">{v || "(blank)"}</span>
                <span className="text-xs text-[var(--color-text-soft)]">{n}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="mt-2 flex justify-between border-t border-[var(--color-rule)] pt-2">
        <button type="button" className="text-xs underline" onClick={() => { onClear(); setQ(""); }}>Clear filter</button>
        <button type="button" className="rounded bg-[var(--color-primary)] px-2 py-0.5 text-xs font-medium text-white" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- drawer */

function ExplainDrawer({ strategyId, row, onClose }: { strategyId: string; row: StrategyGridRow | undefined; onClose: () => void }) {
  const [data, setData] = useState<{ explain: ExplainResult; revisions: Revision[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/calculation-strategies/${strategyId}`)
      .then((r) => r.json())
      .then((j) => { if (live) { if (j.ok) setData(j.data); else setError(j.error ?? "Could not load."); } })
      .catch(() => live && setError("Could not load."));
    return () => { live = false; };
  }, [strategyId]);

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-auto border-l border-[var(--color-rule-strong)] bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-[var(--color-rule)] px-4 py-3">
        <div>
          <div className="eyebrow text-[var(--color-text-soft)]">Calculation</div>
          <div className="text-lg font-semibold">{row ? `${row.individualName} — ${row.label}` : "Strategy"}</div>
          {row?.periodStart && <div className="text-xs text-[var(--color-text-soft)]">Budget period {row.periodStart} → {row.periodEnd} (from renewal date)</div>}
        </div>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 text-lg hover:bg-black/5" aria-label="Close">×</button>
      </div>
      <div className="px-4 py-3 text-sm">
        {error && <div className="text-red-600">{error}</div>}
        {!data && !error && <div className="text-[var(--color-text-soft)]">Loading…</div>}
        {data && (
          <>
            <div className="eyebrow mb-1 text-[var(--color-text-soft)]">Yearly gross = Σ (program hours × internal rate)</div>
            <table className="mb-3 w-full text-xs">
              <tbody>
                {data.explain.lineGross.map((l, i) => (
                  <tr key={i}><td className="py-0.5">{l.programLabel}</td><td className="py-0.5 text-right tabular-nums">{formatHours(l.hours)}h × {formatMoney(l.rate)}</td><td className="py-0.5 text-right tabular-nums font-medium">{formatMoney(l.gross)}</td></tr>
                ))}
              </tbody>
            </table>
            <div className="space-y-1.5">
              {data.explain.steps.map((s) => (
                <div key={s.key} className="flex items-baseline justify-between gap-3 border-b border-[var(--color-rule)] py-1">
                  <div><div className="font-medium">{s.label}</div><div className="text-xs text-[var(--color-text-soft)]">{s.formula}</div></div>
                  <div className="tabular-nums font-semibold">{s.value ? formatMoney(s.value) : "—"}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 space-y-1.5 border-t border-[var(--color-rule)] pt-3">
              <div className="eyebrow text-[var(--color-text-soft)]">Open</div>
              {row && <Link href={`/individuals/${row.individualId}`} className="block text-[var(--color-primary)] hover:underline">Individual profile →</Link>}
              {row && <Link href={`/transactions`} className="block text-[var(--color-primary)] hover:underline">Billed transactions →</Link>}
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
