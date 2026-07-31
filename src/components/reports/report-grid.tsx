"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { dec, formatMoney, formatHours } from "@/lib/money";
import type { ReportTable, ReportColumn, ReportCell, ReportCellRow } from "@/lib/data/report-queries";

/* ------------------------------------------------------------------ types */

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
  search: string;
}

/* -------------------------------------------------------------- helpers */

const INDIVIDUAL_KEYS = new Set(["individual", "individualName", "name"]);
const EMPLOYEE_KEYS = new Set(["employee", "employeeName"]);

const isNumeric = (t: ReportColumn["type"]): boolean =>
  t === "money" || t === "hours" || t === "int" || t === "percent";

function rawValue(row: ReportCellRow, key: string): string {
  const v = row[key];
  return v === null || v === undefined ? "" : String(v);
}

function numValue(row: ReportCellRow, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined || v === "") return null;
  try {
    return dec(v).toNumber();
  } catch {
    return null;
  }
}

function cellText(col: ReportColumn, row: ReportCellRow): string {
  const v = row[col.key];
  if (v === null || v === undefined || v === "") return "—";
  switch (col.type) {
    case "money":
      return formatMoney(v);
    case "hours":
      return formatHours(v);
    case "percent":
      return `${dec(v).toDecimalPlaces(1)}%`;
    case "int":
      return Number(v).toLocaleString();
    default:
      return String(v);
  }
}

function idFor(row: ReportCellRow, col: ReportColumn): { href: string } | null {
  if (INDIVIDUAL_KEYS.has(col.key) && row.individualId) {
    return { href: `/individuals/${String(row.individualId)}` };
  }
  if (EMPLOYEE_KEYS.has(col.key) && row.employeeId) {
    return { href: `/employees/${String(row.employeeId)}` };
  }
  return null;
}

function passesFilter(col: ReportColumn, row: ReportCellRow, f: ColumnFilter | undefined): boolean {
  if (!f) return true;
  if (isNumeric(col.type)) {
    const n = numValue(row, col.key);
    if (f.min != null && f.min !== "" && (n === null || n < Number(f.min))) return false;
    if (f.max != null && f.max !== "" && (n === null || n > Number(f.max))) return false;
    return true;
  }
  if (col.type === "date") {
    const v = rawValue(row, col.key);
    if (f.from && (!v || v < f.from)) return false;
    if (f.to && (!v || v > f.to)) return false;
    return true;
  }
  const v = rawValue(row, col.key);
  if (f.selected && f.selected.length > 0 && !f.selected.includes(v)) return false;
  if (f.contains && !v.toLowerCase().includes(f.contains.toLowerCase())) return false;
  return true;
}

function filterActive(col: ReportColumn, f: ColumnFilter | undefined): boolean {
  if (!f) return false;
  if (isNumeric(col.type)) return (f.min != null && f.min !== "") || (f.max != null && f.max !== "");
  if (col.type === "date") return Boolean(f.from || f.to);
  return Boolean((f.selected && f.selected.length > 0) || f.contains);
}

/* -------------------------------------------------------------- component */

export default function ReportGrid({
  table,
  reportKey,
  canManage,
}: {
  table: ReportTable;
  reportKey: string;
  canManage: boolean;
}) {
  const columns = table.columns;
  const gridKey = `report:${reportKey}`;

  const colByKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  const searchKeys = useMemo(() => columns.filter((c) => c.type === "text").map((c) => c.key), [columns]);

  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  const [sort, setSort] = useState<SortKey[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [showCols, setShowCols] = useState(false);

  const [views, setViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const visibleCols = useMemo(() => columns.filter((c) => !hidden.has(c.key)), [columns, hidden]);

  useEffect(() => {
    fetch(`/api/grid-views?grid=${encodeURIComponent(gridKey)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.data) setViews(j.data as SavedView[]);
      })
      .catch(() => {});
  }, [gridKey]);

  /* ---- derived: filter → sort → totals ---- */

  const applyAll = useCallback(
    (exceptKey?: string) =>
      table.rows.filter((r) => {
        for (const col of columns) {
          if (col.key === exceptKey) continue;
          if (!passesFilter(col, r, filters[col.key])) return false;
        }
        if (search.trim()) {
          const q = search.trim().toLowerCase();
          const hit = searchKeys.some((k) => rawValue(r, k).toLowerCase().includes(q));
          if (!hit) return false;
        }
        return true;
      }),
    [table.rows, columns, filters, search, searchKeys],
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
        if (isNumeric(col.type)) {
          const na = numValue(a, col.key);
          const nb = numValue(b, col.key);
          cmp = (na ?? -Infinity) - (nb ?? -Infinity);
        } else {
          cmp = rawValue(a, col.key).localeCompare(rawValue(b, col.key), undefined, { numeric: true });
        }
        if (cmp !== 0) return s.dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
    return arr;
  }, [filtered, sort, colByKey]);

  const totalCols = useMemo(
    () => columns.filter((c) => c.type === "money" || c.type === "hours" || c.type === "int"),
    [columns],
  );

  const totals = useMemo(
    () =>
      totalCols.map((c) => {
        let sum = dec(0);
        for (const r of filtered) {
          const v = r[c.key];
          if (v === null || v === undefined || v === "") continue;
          try {
            sum = sum.plus(dec(v));
          } catch {
            /* skip unparseable */
          }
        }
        const label =
          c.type === "money"
            ? formatMoney(sum.toFixed(2))
            : c.type === "hours"
              ? formatHours(sum.toFixed(2))
              : sum.toDecimalPlaces(0).toNumber().toLocaleString();
        return { key: c.key, header: c.header, label };
      }),
    [totalCols, filtered],
  );

  /* ---- value counts for the open text column's popover ---- */
  const valueCounts = useMemo<[string, number][]>(() => {
    if (!openFilter) return [];
    const col = colByKey.get(openFilter);
    if (!col || col.type !== "text") return [];
    const base = applyAll(openFilter);
    const counts = new Map<string, number>();
    for (const r of base) {
      const v = rawValue(r, col.key);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [openFilter, applyAll, colByKey]);

  /* ---- actions ---- */

  const toggleSort = (key: string, additive: boolean) => {
    setSort((prev) => {
      const existing = prev.find((s) => s.key === key);
      const nextDir: "asc" | "desc" = existing?.dir === "asc" ? "desc" : "asc";
      if (additive) {
        const others = prev.filter((s) => s.key !== key);
        return existing && existing.dir === "desc" ? others : [...others, { key, dir: nextDir }];
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
    setSort([]);
  };

  const anyFilter = search.trim() !== "" || columns.some((c) => filterActive(c, filters[c.key]));

  const currentConfig = (): ViewConfig => ({ filters, sort, hidden: [...hidden], search });

  const applyConfig = (cfg: ViewConfig) => {
    setFilters(cfg.filters ?? {});
    setSort(cfg.sort ?? []);
    setHidden(new Set(cfg.hidden ?? []));
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
        body: JSON.stringify({ gridKey, name, config: currentConfig() }),
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
      await fetch(`/api/grid-views/${v.id}?grid=${encodeURIComponent(gridKey)}`, { method: "DELETE" });
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
      const cols = visibleCols.map((c) => ({ key: c.key, header: c.header, type: c.type }));
      const outRows = sorted.map((r) => {
        const o: Record<string, ReportCell> = {};
        for (const c of visibleCols) o[c.key] = r[c.key] ?? null;
        return o;
      });
      const res = await fetch("/api/grid/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          format,
          title: table.title ?? "Report",
          filename: reportKey,
          columns: cols,
          rows: outRows,
        }),
      });
      if (!res.ok) throw new Error("Export failed.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reportKey}-${new Date().toISOString().slice(0, 10)}.${format}`;
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

  /* ---------------------------------------------------------------- render */

  const tileCls = "rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2";

  return (
    <div className="space-y-3">
      {table.title && <h2 className="text-base font-semibold">{table.title}</h2>}

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="input min-w-[220px] flex-1"
        />
        <button type="button" onClick={() => setShowCols((s) => !s)} className="btn btn-sm btn-secondary">
          Columns ({visibleCols.length})
        </button>
        <button
          type="button"
          onClick={() => exportView("csv")}
          disabled={busy}
          className="btn btn-sm btn-secondary disabled:opacity-50"
        >
          Export CSV
        </button>
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
          <span
            key={v.id}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-rule-strong)] bg-white px-2 py-0.5"
          >
            <button type="button" className="font-medium hover:underline" onClick={() => applyConfig(v.config as ViewConfig)}>
              {v.name}
            </button>
            {canManage && (
              <button
                type="button"
                aria-label={`Delete ${v.name}`}
                className="text-[var(--color-text-soft)] hover:text-red-600"
                onClick={() => deleteView(v)}
              >
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
            <button
              type="button"
              onClick={saveView}
              disabled={busy || !viewName.trim()}
              className="btn btn-sm btn-primary disabled:opacity-50"
            >
              Save view
            </button>
          </span>
        )}
      </div>

      {notice && (
        <div className="rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-1.5 text-sm">{notice}</div>
      )}

      {/* column chooser */}
      {showCols && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] p-3 text-sm">
          {columns.map((c) => (
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
          <button type="button" className="ml-2 underline" onClick={() => setHidden(new Set())}>
            Reset
          </button>
        </div>
      )}

      {/* grid */}
      <div className="scroll-thin max-h-[62vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-20">
            <tr>
              {visibleCols.map((c) => {
                const sortIdx = sort.findIndex((s) => s.key === c.key);
                const s = sort[sortIdx];
                const active = filterActive(c, filters[c.key]);
                return (
                  <th
                    key={c.key}
                    className="relative border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 text-left align-bottom font-semibold whitespace-nowrap"
                  >
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        className="flex-1 truncate text-left hover:underline"
                        title="Click to sort, Shift-click to add a sort level"
                        onClick={(e) => toggleSort(c.key, e.shiftKey)}
                      >
                        {c.header}
                        {s && (
                          <span className="ml-1 text-[10px] text-[var(--color-primary)]">
                            {s.dir === "asc" ? "▲" : "▼"}
                            {sort.length > 1 ? sortIdx + 1 : ""}
                          </span>
                        )}
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
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={i} className="hover:bg-black/[0.03]">
                {visibleCols.map((c) => {
                  const numeric = isNumeric(c.type);
                  const link = idFor(r, c);
                  return (
                    <td
                      key={c.key}
                      className={`whitespace-nowrap border-b border-r border-[var(--color-rule)] px-2 py-1 ${numeric ? "text-right tabular-nums" : "text-left"}`}
                    >
                      {link ? (
                        <Link href={link.href} className="text-[var(--color-primary)] font-medium hover:underline">
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
            {sorted.length === 0 && (
              <tr>
                <td colSpan={visibleCols.length} className="px-3 py-10 text-center text-[var(--color-text-soft)]">
                  {table.emptyMessage ?? "No rows match the current filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* filtered totals */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {totals.map((t) => (
          <div key={t.key} className={tileCls}>
            <div className="eyebrow text-[var(--color-text-soft)]">{t.header}</div>
            <div className="text-lg font-semibold tabular-nums">{t.label}</div>
          </div>
        ))}
        <div className={tileCls}>
          <div className="eyebrow text-[var(--color-text-soft)]"># Rows</div>
          <div className="text-lg font-semibold tabular-nums">{filtered.length.toLocaleString()}</div>
        </div>
      </div>
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
  col: ReportColumn;
  filter: ColumnFilter | undefined;
  values: [string, number][];
  onChange: (patch: Partial<ColumnFilter> | null) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const isNum = isNumeric(col.type);
  const isDate = col.type === "date";
  const selected = new Set(filter?.selected ?? []);
  const [q, setQ] = useState(filter?.contains ?? "");
  const shown = q ? values.filter(([v]) => v.toLowerCase().includes(q.toLowerCase())) : values;

  return (
    <div
      className="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-[var(--color-rule-strong)] bg-white p-2 text-sm font-normal shadow-lg"
      onClick={(e) => e.stopPropagation()}
    >
      {isNum && (
        <div className="flex items-center gap-2">
          <input
            type="number"
            placeholder="Min"
            defaultValue={filter?.min ?? ""}
            onChange={(e) => onChange({ min: e.target.value })}
            className="w-full rounded border border-[var(--color-rule-strong)] px-2 py-1"
          />
          <input
            type="number"
            placeholder="Max"
            defaultValue={filter?.max ?? ""}
            onChange={(e) => onChange({ max: e.target.value })}
            className="w-full rounded border border-[var(--color-rule-strong)] px-2 py-1"
          />
        </div>
      )}
      {isDate && (
        <div className="space-y-2">
          <label className="block">
            From
            <input
              type="date"
              defaultValue={filter?.from ?? ""}
              onChange={(e) => onChange({ from: e.target.value })}
              className="mt-0.5 w-full rounded border border-[var(--color-rule-strong)] px-2 py-1"
            />
          </label>
          <label className="block">
            To
            <input
              type="date"
              defaultValue={filter?.to ?? ""}
              onChange={(e) => onChange({ to: e.target.value })}
              className="mt-0.5 w-full rounded border border-[var(--color-rule-strong)] px-2 py-1"
            />
          </label>
        </div>
      )}
      {!isNum && !isDate && (
        <div>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              onChange({ contains: e.target.value });
            }}
            placeholder="Contains…"
            className="mb-1 w-full rounded border border-[var(--color-rule-strong)] px-2 py-1"
          />
          <div className="mb-1 flex justify-between text-xs text-[var(--color-text-soft)]">
            <button type="button" className="underline" onClick={() => onChange({ selected: shown.map(([v]) => v) })}>
              Select all
            </button>
            <button type="button" className="underline" onClick={() => onChange({ selected: [] })}>
              Clear
            </button>
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
        <button
          type="button"
          className="text-xs underline"
          onClick={() => {
            onClear();
            setQ("");
          }}
        >
          Clear filter
        </button>
        <button
          type="button"
          className="rounded bg-[var(--color-primary)] px-2 py-0.5 text-xs font-medium text-white"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>
  );
}
