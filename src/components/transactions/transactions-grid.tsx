"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { dec, formatMoney, formatHours } from "@/lib/money";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import type { ExportFieldType } from "@/lib/export/tabular";
import { computeGridTotals } from "@/lib/business/transaction-totals";

/* ------------------------------------------------------------------ types */

type FieldType = "text" | "money" | "hours" | "date" | "int" | "badge";

interface ColumnDef {
  key: string;
  header: string;
  type: FieldType;
  width: number;
  defaultVisible: boolean;
  frozen?: boolean;
  get: (r: GridTransaction) => string | null;
}

interface ColumnFilter {
  selected?: string[]; // chosen text values (empty/undefined ⇒ all)
  contains?: string; // text substring
  min?: string;
  max?: string;
  from?: string; // date ISO
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

interface ViewConfig {
  filters: Record<string, ColumnFilter>;
  sort: SortKey[];
  hidden: string[];
  widths: Record<string, number>;
  search: string;
}

/* ------------------------------------------------------------- columns */

const COLUMNS: ColumnDef[] = [
  { key: "checkDate", header: "Check date", type: "date", width: 110, defaultVisible: true, frozen: true, get: (r) => r.checkDate },
  { key: "individual", header: "Individual", type: "text", width: 170, defaultVisible: true, frozen: true, get: (r) => r.individual },
  { key: "employee", header: "Employee", type: "text", width: 170, defaultVisible: true, get: (r) => r.employee },
  { key: "program", header: "Program", type: "text", width: 150, defaultVisible: true, get: (r) => r.program },
  { key: "payTo", header: "Pay to", type: "text", width: 150, defaultVisible: true, get: (r) => r.payTo },
  { key: "checkNumber", header: "Check #", type: "text", width: 90, defaultVisible: true, get: (r) => r.checkNumber },
  { key: "hours", header: "Hours", type: "hours", width: 80, defaultVisible: true, get: (r) => r.hours },
  { key: "rate", header: "Rate", type: "money", width: 80, defaultVisible: false, get: (r) => r.rate },
  { key: "gross", header: "Gross amount", type: "money", width: 120, defaultVisible: true, get: (r) => r.gross },
  { key: "internalAmount", header: "Internal amount", type: "money", width: 130, defaultVisible: true, get: (r) => r.internalAmount },
  { key: "agencyAdditional", header: "Agency additional", type: "money", width: 140, defaultVisible: true, get: (r) => r.agencyAdditional },
  { key: "totalNetPay", header: "Total net pay", type: "money", width: 120, defaultVisible: true, get: (r) => r.totalNetPay },
  { key: "periodBegin", header: "Period begin", type: "date", width: 110, defaultVisible: false, get: (r) => r.periodBegin },
  { key: "periodEnd", header: "Period end", type: "date", width: 110, defaultVisible: false, get: (r) => r.periodEnd },
  { key: "paymentRecipient", header: "Payment recipient", type: "badge", width: 150, defaultVisible: false, get: (r) => r.paymentRecipient },
  { key: "matchStatus", header: "Match status", type: "badge", width: 120, defaultVisible: false, get: (r) => r.matchStatus },
  { key: "groupStatus", header: "Group status", type: "badge", width: 120, defaultVisible: false, get: (r) => (r.isGroup ? "Group" : "Individual") },
];

const COL_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));
const SEARCH_KEYS = ["individual", "employee", "program", "payTo", "checkNumber"];
const EXPORT_TYPE: Record<FieldType, ExportFieldType> = {
  text: "text", money: "money", hours: "hours", date: "date", int: "int", badge: "text",
};
const ROW_H = 33;
const RECIPIENT_LABEL: Record<string, string> = {
  employee: "Paid to employee",
  excellent_staffing: "Payable by agency",
  unknown: "Unknown",
};

/* -------------------------------------------------------------- helpers */

function cellText(col: ColumnDef, r: GridTransaction): string {
  const v = col.get(r);
  if (v === null || v === undefined || v === "") return "";
  if (col.type === "money") return formatMoney(v);
  if (col.type === "hours") return formatHours(v);
  if (col.type === "badge") return RECIPIENT_LABEL[v] ?? v;
  return String(v);
}

function rawValue(col: ColumnDef, r: GridTransaction): string {
  const v = col.get(r);
  return v === null || v === undefined ? "" : String(v);
}

function numValue(col: ColumnDef, r: GridTransaction): number | null {
  const v = col.get(r);
  if (v === null || v === undefined || v === "") return null;
  try {
    return dec(v).toNumber();
  } catch {
    return null;
  }
}

function passesFilter(col: ColumnDef, r: GridTransaction, f: ColumnFilter | undefined): boolean {
  if (!f) return true;
  if (col.type === "money" || col.type === "hours" || col.type === "int") {
    const n = numValue(col, r);
    if (f.min != null && f.min !== "" && (n === null || n < Number(f.min))) return false;
    if (f.max != null && f.max !== "" && (n === null || n > Number(f.max))) return false;
    return true;
  }
  if (col.type === "date") {
    const v = rawValue(col, r);
    if (f.from && (!v || v < f.from)) return false;
    if (f.to && (!v || v > f.to)) return false;
    return true;
  }
  const v = rawValue(col, r);
  if (f.selected && f.selected.length > 0 && !f.selected.includes(v)) return false;
  if (f.contains && !v.toLowerCase().includes(f.contains.toLowerCase())) return false;
  return true;
}

function filterActive(col: ColumnDef, f: ColumnFilter | undefined): boolean {
  if (!f) return false;
  if (col.type === "money" || col.type === "hours" || col.type === "int") {
    return (f.min != null && f.min !== "") || (f.max != null && f.max !== "");
  }
  if (col.type === "date") return Boolean(f.from || f.to);
  return Boolean((f.selected && f.selected.length > 0) || f.contains);
}

/* -------------------------------------------------------------- component */

export default function TransactionsGrid({
  rows,
  canManage,
}: {
  rows: GridTransaction[];
  canManage: boolean;
}) {
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  const [sort, setSort] = useState<SortKey[]>([{ key: "checkDate", dir: "desc" }]);
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(COLUMNS.filter((c) => !c.defaultVisible).map((c) => c.key)),
  );
  const [widths, setWidths] = useState<Record<string, number>>(
    () => Object.fromEntries(COLUMNS.map((c) => [c.key, c.width])),
  );
  const [search, setSearch] = useState("");
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [showCols, setShowCols] = useState(false);
  const [selected, setSelected] = useState<GridTransaction | null>(null);

  // saved views
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(560);

  const visibleCols = useMemo(() => COLUMNS.filter((c) => !hidden.has(c.key)), [hidden]);

  useEffect(() => {
    fetch("/api/grid-views?grid=transactions")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.data) setViews(j.data as SavedView[]);
      })
      .catch(() => {});
  }, []);

  /* ---- derived: filter → sort → totals ---- */

  const applyAll = useCallback(
    (exceptKey?: string) =>
      rows.filter((r) => {
        for (const col of COLUMNS) {
          if (col.key === exceptKey) continue;
          if (!passesFilter(col, r, filters[col.key])) return false;
        }
        if (search.trim()) {
          const q = search.trim().toLowerCase();
          const hit = SEARCH_KEYS.some((k) => {
            const c = COL_BY_KEY.get(k);
            return c ? rawValue(c, r).toLowerCase().includes(q) : false;
          });
          if (!hit) return false;
        }
        return true;
      }),
    [rows, filters, search],
  );

  const filtered = useMemo(() => applyAll(), [applyAll]);

  const sorted = useMemo(() => {
    if (sort.length === 0) return filtered;
    const arr = filtered.slice();
    arr.sort((a, b) => {
      for (const s of sort) {
        const col = COL_BY_KEY.get(s.key);
        if (!col) continue;
        let cmp = 0;
        if (col.type === "money" || col.type === "hours" || col.type === "int") {
          const na = numValue(col, a);
          const nb = numValue(col, b);
          cmp = (na ?? -Infinity) - (nb ?? -Infinity);
        } else {
          cmp = rawValue(col, a).localeCompare(rawValue(col, b), undefined, { numeric: true });
        }
        if (cmp !== 0) return s.dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
    return arr;
  }, [filtered, sort]);

  const totals = useMemo(() => computeGridTotals(filtered), [filtered]);

  /* ---- value counts for the open column's filter popover ---- */
  const valueCounts = useMemo(() => {
    if (!openFilter) return [];
    const col = COL_BY_KEY.get(openFilter);
    if (!col || col.type === "money" || col.type === "hours" || col.type === "int" || col.type === "date") return [];
    const base = applyAll(openFilter);
    const counts = new Map<string, number>();
    for (const r of base) {
      const v = rawValue(col, r);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [openFilter, applyAll]);

  /* ---- virtualization ---- */
  const total = sorted.length;
  const overscan = 8;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - overscan);
  const visibleCount = Math.ceil(viewportH / ROW_H) + overscan * 2;
  const endIdx = Math.min(total, startIdx + visibleCount);
  const topPad = startIdx * ROW_H;
  const bottomPad = Math.max(0, (total - endIdx) * ROW_H);
  const windowed = sorted.slice(startIdx, endIdx);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight || 560);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // frozen-column left offsets (leading run of visible frozen columns)
  const frozenLeft = useMemo(() => {
    const map: Record<string, number> = {};
    let left = 0;
    for (const c of visibleCols) {
      if (!c.frozen) break;
      map[c.key] = left;
      left += widths[c.key] ?? c.width;
    }
    return map;
  }, [visibleCols, widths]);

  /* ---- actions ---- */

  const toggleSort = (key: string, additive: boolean) => {
    setSort((prev) => {
      const existing = prev.find((s) => s.key === key);
      const nextDir: "asc" | "desc" = existing?.dir === "asc" ? "desc" : "asc";
      if (additive) {
        const others = prev.filter((s) => s.key !== key);
        return existing && existing.dir === "desc"
          ? others // third click removes
          : [...others, { key, dir: nextDir }];
      }
      if (existing) return existing.dir === "desc" ? [] : [{ key, dir: "desc" }];
      return [{ key, dir: "asc" }];
    });
  };

  const setFilter = (key: string, patch: Partial<ColumnFilter> | null) => {
    setFilters((prev) => {
      const next = { ...prev };
      if (patch === null) delete next[key];
      else next[key] = { ...prev[key], ...patch };
      return next;
    });
  };

  const clearAll = () => {
    setFilters({});
    setSearch("");
    setSort([{ key: "checkDate", dir: "desc" }]);
  };

  const anyFilter = search.trim() !== "" || COLUMNS.some((c) => filterActive(c, filters[c.key]));

  const currentConfig = (): ViewConfig => ({
    filters,
    sort,
    hidden: [...hidden],
    widths,
    search,
  });

  const applyConfig = (cfg: ViewConfig) => {
    setFilters(cfg.filters ?? {});
    setSort(cfg.sort ?? []);
    setHidden(new Set(cfg.hidden ?? []));
    setWidths({ ...Object.fromEntries(COLUMNS.map((c) => [c.key, c.width])), ...(cfg.widths ?? {}) });
    setSearch(cfg.search ?? "");
  };

  const saveView = async () => {
    const name = viewName.trim();
    if (!name) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/grid-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gridKey: "transactions", name, config: currentConfig() }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save the view.");
      setViews((prev) => {
        const without = prev.filter((v) => v.name !== name);
        return [...without, j.data as SavedView].sort((a, b) => a.name.localeCompare(b.name));
      });
      setViewName("");
      setNotice(`Saved view “${name}”.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not save the view.");
    } finally {
      setBusy(false);
    }
  };

  const deleteView = async (v: SavedView) => {
    setBusy(true);
    try {
      await fetch(`/api/grid-views/${v.id}?grid=transactions`, { method: "DELETE" });
      setViews((prev) => prev.filter((x) => x.id !== v.id));
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  const exportView = async (format: "csv" | "xlsx") => {
    setBusy(true);
    try {
      const cols = visibleCols.map((c) => ({ key: c.key, header: c.header, type: EXPORT_TYPE[c.type] }));
      const outRows = sorted.map((r) => {
        const o: Record<string, string | null> = {};
        for (const c of visibleCols) o[c.key] = c.get(r);
        return o;
      });
      const res = await fetch("/api/transactions/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format, title: "Transactions", filename: "transactions", columns: cols, rows: outRows }),
      });
      if (!res.ok) throw new Error("Export failed.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transactions-${new Date().toISOString().slice(0, 10)}.${format}`;
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

  // column resize drag
  const dragRef = useRef<{ key: string; startX: number; startW: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const w = Math.max(56, d.startW + (e.clientX - d.startX));
      setWidths((prev) => ({ ...prev, [d.key]: w }));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  /* ---------------------------------------------------------------- render */

  const tileCls = "rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2";

  return (
    <div className="space-y-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search individual, employee, program, pay to, check #…"
          className="input min-w-[260px] flex-1"
        />
        <button
          type="button"
          onClick={() => setShowCols((s) => !s)}
          className="btn btn-sm btn-secondary"
        >
          Columns ({visibleCols.length})
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => exportView("csv")}
            disabled={busy}
            className="btn btn-sm btn-secondary disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
        <button
          type="button"
          onClick={() => exportView("xlsx")}
          disabled={busy}
          className="btn btn-sm btn-secondary disabled:opacity-50"
        >
          Export Excel
        </button>
        <button
          type="button"
          onClick={clearAll}
          disabled={!anyFilter}
          className="btn btn-sm btn-secondary disabled:opacity-40"
        >
          Clear all filters
        </button>
      </div>

      {/* saved views row */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="eyebrow text-[var(--color-text-soft)]">Saved views</span>
        {views.length === 0 && <span className="text-[var(--color-text-soft)]">None yet</span>}
        {views.map((v) => (
          <span key={v.id} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-rule-strong)] bg-white px-2 py-0.5">
            <button type="button" className="font-medium hover:underline" onClick={() => applyConfig(v.config as ViewConfig)}>
              {v.name}
            </button>
            {canManage && (
              <button type="button" aria-label={`Delete ${v.name}`} className="text-[var(--color-text-soft)] hover:text-red-600" onClick={() => deleteView(v)}>
                ×
              </button>
            )}
          </span>
        ))}
        {canManage && (
          <span className="ml-auto inline-flex items-center gap-1">
            <input
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              placeholder="Name this view"
              className="w-36 rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1"
            />
            <button type="button" onClick={saveView} disabled={busy || !viewName.trim()} className="btn btn-sm btn-primary disabled:opacity-50">
              Save view
            </button>
          </span>
        )}
      </div>

      {notice && <div className="rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-1.5 text-sm">{notice}</div>}

      {/* column chooser */}
      {showCols && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] p-3 text-sm">
          {COLUMNS.map((c) => (
            <label key={c.key} className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={!hidden.has(c.key)}
                onChange={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(c.key)) next.delete(c.key);
                    else next.add(c.key);
                    return next;
                  })
                }
              />
              {c.header}
            </label>
          ))}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => setHidden(new Set(COLUMNS.filter((c) => !c.defaultVisible).map((c) => c.key)))}
          >
            Reset
          </button>
        </div>
      )}

      {/* grid */}
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        className="relative max-h-[62vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]"
      >
        <table className="border-collapse text-sm" style={{ tableLayout: "fixed", width: visibleCols.reduce((s, c) => s + (widths[c.key] ?? c.width), 0) }}>
          <colgroup>
            {visibleCols.map((c) => (
              <col key={c.key} style={{ width: widths[c.key] ?? c.width }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-20">
            <tr>
              {visibleCols.map((c) => {
                const sortIdx = sort.findIndex((s) => s.key === c.key);
                const s = sort[sortIdx];
                const isFrozen = c.key in frozenLeft;
                const active = filterActive(c, filters[c.key]);
                return (
                  <th
                    key={c.key}
                    className="relative border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 text-left align-bottom font-semibold"
                    style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 30 } : undefined}
                  >
                    <div className="flex items-center gap-1">
                      <button type="button" className="flex-1 truncate text-left hover:underline" title="Click to sort, Shift-click to add a sort level" onClick={(e) => toggleSort(c.key, e.shiftKey)}>
                        {c.header}
                        {s && <span className="ml-1 text-[10px] text-[var(--color-primary)]">{s.dir === "asc" ? "▲" : "▼"}{sort.length > 1 ? sortIdx + 1 : ""}</span>}
                      </button>
                      <button
                        type="button"
                        aria-label={`Filter ${c.header}`}
                        onClick={() => setOpenFilter((k) => (k === c.key ? null : c.key))}
                        className={`shrink-0 rounded px-1 text-xs ${active ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-soft)] hover:bg-black/5"}`}
                      >
                        ▾
                      </button>
                    </div>
                    {openFilter === c.key && (
                      <FilterPopover
                        col={c}
                        filter={filters[c.key]}
                        values={valueCounts}
                        onChange={(patch) => setFilter(c.key, patch)}
                        onClear={() => setFilter(c.key, null)}
                        onClose={() => setOpenFilter(null)}
                      />
                    )}
                    <span
                      onMouseDown={(e) => {
                        e.preventDefault();
                        dragRef.current = { key: c.key, startX: e.clientX, startW: widths[c.key] ?? c.width };
                      }}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none hover:bg-[var(--color-primary)]"
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {topPad > 0 && (
              <tr style={{ height: topPad }}>
                <td colSpan={visibleCols.length} />
              </tr>
            )}
            {windowed.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelected(r)}
                className={`cursor-pointer ${selected?.id === r.id ? "bg-[var(--color-primary-soft,#eef2ff)]" : "hover:bg-black/[0.03]"}`}
                style={{ height: ROW_H }}
              >
                {visibleCols.map((c) => {
                  const isFrozen = c.key in frozenLeft;
                  const numeric = c.type === "money" || c.type === "hours" || c.type === "int";
                  return (
                    <td
                      key={c.key}
                      className={`overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-[var(--color-rule)] px-2 ${numeric ? "text-right tabular-nums" : "text-left"}`}
                      style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 10, background: selected?.id === r.id ? "var(--color-primary-soft,#eef2ff)" : "white" } : undefined}
                    >
                      {c.key === "individual" && r.individualId ? (
                        <Link href={`/individuals/${r.individualId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                          {cellText(c, r)}
                        </Link>
                      ) : c.key === "employee" && r.employeeId ? (
                        <Link href={`/employees/${r.employeeId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                          {cellText(c, r)}
                        </Link>
                      ) : (
                        cellText(c, r)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {bottomPad > 0 && (
              <tr style={{ height: bottomPad }}>
                <td colSpan={visibleCols.length} />
              </tr>
            )}
            {total === 0 && (
              <tr>
                <td colSpan={visibleCols.length} className="px-3 py-10 text-center text-[var(--color-text-soft)]">
                  No transactions match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* filtered subtotals (SUBTOTAL-style: recompute on the visible filter) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Filtered gross</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.gross)}</div></div>
        <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Internal / employee</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.internal)}</div></div>
        <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Agency additional</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.agencyAdditional)}</div></div>
        <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Net pay (per check)</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.netPerCheck)}</div></div>
        <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Hours</div><div className="text-lg font-semibold tabular-nums">{formatHours(totals.hours)}</div></div>
        <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]"># Transactions</div><div className="text-lg font-semibold tabular-nums">{totals.transactions.toLocaleString()}</div></div>
        <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]"># Checks</div><div className="text-lg font-semibold tabular-nums">{totals.checks.toLocaleString()}</div></div>
        <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]"># Individuals</div><div className="text-lg font-semibold tabular-nums">{totals.individuals.toLocaleString()}</div></div>
        <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]"># Employees</div><div className="text-lg font-semibold tabular-nums">{totals.employees.toLocaleString()}</div></div>
      </div>

      {selected && <DetailDrawer row={selected} onClose={() => setSelected(null)} onFilterCheck={(cn) => { setFilter("checkNumber", { selected: [cn], contains: "" }); setSelected(null); }} />}
    </div>
  );
}

/* ------------------------------------------------------------- popover */

function FilterPopover({
  col,
  filter,
  values,
  onChange,
  onClear,
  onClose,
}: {
  col: ColumnDef;
  filter: ColumnFilter | undefined;
  values: [string, number][];
  onChange: (patch: Partial<ColumnFilter> | null) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const isNum = col.type === "money" || col.type === "hours" || col.type === "int";
  const isDate = col.type === "date";
  const selected = new Set(filter?.selected ?? []);
  const [q, setQ] = useState(filter?.contains ?? "");
  const shown = q ? values.filter(([v]) => v.toLowerCase().includes(q.toLowerCase())) : values;

  return (
    <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-[var(--color-rule-strong)] bg-white p-2 text-sm font-normal shadow-lg" onClick={(e) => e.stopPropagation()}>
      {isNum && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input type="number" placeholder="Min" defaultValue={filter?.min ?? ""} onChange={(e) => onChange({ min: e.target.value })} className="w-full rounded border border-[var(--color-rule-strong)] px-2 py-1" />
            <input type="number" placeholder="Max" defaultValue={filter?.max ?? ""} onChange={(e) => onChange({ max: e.target.value })} className="w-full rounded border border-[var(--color-rule-strong)] px-2 py-1" />
          </div>
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
          <div className="max-h-48 overflow-auto">
            {shown.length === 0 && <div className="px-1 py-2 text-xs text-[var(--color-text-soft)]">No values</div>}
            {shown.map(([v, n]) => (
              <label key={v} className="flex items-center gap-1.5 px-1 py-0.5 hover:bg-black/5">
                <input
                  type="checkbox"
                  checked={selected.size === 0 ? false : selected.has(v)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(v);
                    else next.delete(v);
                    onChange({ selected: [...next] });
                  }}
                />
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

/* ------------------------------------------------------------- drawer */

function DetailDrawer({
  row,
  onClose,
  onFilterCheck,
}: {
  row: GridTransaction;
  onClose: () => void;
  onFilterCheck: (checkNumber: string) => void;
}) {
  const line = (label: string, value: ReactNode) => (
    <div className="flex justify-between gap-4 py-1"><span className="text-[var(--color-text-soft)]">{label}</span><span className="text-right font-medium">{value}</span></div>
  );
  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full max-w-sm overflow-auto border-l border-[var(--color-rule-strong)] bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-[var(--color-rule)] px-4 py-3">
        <div>
          <div className="eyebrow text-[var(--color-text-soft)]">Transaction</div>
          <div className="text-lg font-semibold">{row.individual ?? "—"}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 text-lg hover:bg-black/5" aria-label="Close">×</button>
      </div>
      <div className="px-4 py-3 text-sm">
        {line("Check date", row.checkDate ?? "—")}
        {line("Check #", row.checkNumber ?? "—")}
        {line("Program", row.program ?? "—")}
        {line("Pay to", row.payTo ?? "—")}
        {line("Hours", row.hours ? formatHours(row.hours) : "—")}
        {line("Rate", row.rate ? formatMoney(row.rate) : "—")}
        {line("Gross amount", row.gross ? formatMoney(row.gross) : "—")}
        {line("Internal amount", row.internalAmount ? formatMoney(row.internalAmount) : "—")}
        {line("Agency additional", row.agencyAdditional ? formatMoney(row.agencyAdditional) : "—")}
        {line("Total net pay", row.totalNetPay ? formatMoney(row.totalNetPay) : "—")}
        {line("Period", `${row.periodBegin ?? "—"} → ${row.periodEnd ?? "—"}`)}
        {line("Payment recipient", RECIPIENT_LABEL[row.paymentRecipient ?? ""] ?? row.paymentRecipient ?? "—")}
        {line("Match status", row.matchStatus ?? "—")}
        {line("Group", row.isGroup ? "Group service" : "Individual")}

        <div className="mt-4 space-y-1.5 border-t border-[var(--color-rule)] pt-3">
          <div className="eyebrow text-[var(--color-text-soft)]">Open</div>
          {row.individualId && <Link href={`/individuals/${row.individualId}`} className="block text-[var(--color-primary)] hover:underline">Individual profile →</Link>}
          {row.employeeId && <Link href={`/employees/${row.employeeId}`} className="block text-[var(--color-primary)] hover:underline">Employee: {row.employee} →</Link>}
          {row.individualId && <Link href={`/calculations?individualId=${row.individualId}`} className="block text-[var(--color-primary)] hover:underline">Calculation / budget strategy →</Link>}
          {row.checkNumber && <button type="button" onClick={() => onFilterCheck(row.checkNumber as string)} className="block text-left text-[var(--color-primary)] hover:underline">Show all rows on check {row.checkNumber} →</button>}
          {row.sourceFileId && <Link href={`/imports/${row.sourceFileId}`} className="block text-[var(--color-primary)] hover:underline">Import batch →</Link>}
          {row.serviceSessionId && <Link href={`/reconciliation`} className="block text-[var(--color-primary)] hover:underline">Reconciliation record →</Link>}
        </div>
      </div>
    </div>
  );
}
