"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ColumnDef,
  type ColumnFilter,
  type FilterState,
  type SortState,
  type SavedView,
  type GridViewConfig,
  type ValueCount,
  type FilterChip,
} from "./types";
import {
  applyFilters,
  sortRows,
  valueCountsFor,
  toggleSortState,
  filterActive,
  filterChips as filterChipsFor,
  anyFilterActive,
  exportColumns,
  exportRows,
} from "./engine";

export interface UseGridOptions<Row, Totals> {
  rows: Row[];
  columns: ColumnDef<Row>[];
  gridKey: string;
  canManage: boolean;
  initialSort?: SortState;
  initialHidden?: string[];
  initialWidths?: Record<string, number>;
  /** Seed the filter state (e.g. from URL search params, for deep-linked drill-through). */
  initialFilters?: FilterState;
  /** Seed the free-text search box. */
  initialSearch?: string;
  searchKeys?: string[];
  computeTotals?: (filtered: Row[]) => Totals;
  serializeHidden?: boolean;
  serializeWidths?: boolean;
  /** Calculations exports every column (none are hidden); others export visible only. */
  exportAllColumns?: boolean;
}

export interface UseGridResult<Row, Totals> {
  canManage: boolean;
  columns: ColumnDef<Row>[];
  visibleColumns: ColumnDef<Row>[];

  filters: FilterState;
  setFilter: (key: string, patch: Partial<ColumnFilter> | null) => void;
  clearFilters: () => void;

  sort: SortState;
  toggleSort: (key: string, additive: boolean) => void;
  /** Explicit single-level sort from a menu (ascending / descending / cleared). */
  sortColumn: (key: string, dir: "asc" | "desc" | null) => void;

  search: string;
  setSearch: (v: string) => void;

  hidden: Set<string>;
  toggleHidden: (key: string) => void;
  resetHidden: () => void;

  widths: Record<string, number>;
  setWidth: (key: string, w: number) => void;

  filtered: Row[];
  sorted: Row[];
  totals: Totals | null;

  totalCount: number;
  resultCount: number;
  anyFilter: boolean;
  chips: FilterChip[];
  activeFilterColumns: ColumnDef<Row>[];
  valueCounts: (key: string) => ValueCount[];

  views: SavedView[];
  saveView: (name: string) => Promise<void>;
  deleteView: (v: SavedView) => Promise<void>;
  applyView: (cfg: GridViewConfig) => void;
  currentConfig: () => GridViewConfig;

  exportView: (format: "csv" | "xlsx", meta: { endpoint: string; title: string; filename: string }) => Promise<void>;

  busy: boolean;
  notice: string | null;
  setNotice: (v: string | null) => void;
}

export function useGrid<Row, Totals = unknown>(o: UseGridOptions<Row, Totals>): UseGridResult<Row, Totals> {
  const initialSort = useMemo(() => o.initialSort ?? [], [o.initialSort]);
  const searchKeys = useMemo(
    () => o.searchKeys ?? o.columns.filter((c) => c.kind === "text").map((c) => c.key),
    [o.searchKeys, o.columns],
  );

  const [filters, setFilters] = useState<FilterState>(() => ({ ...(o.initialFilters ?? {}) }));
  const [sort, setSort] = useState<SortState>(initialSort);
  const [search, setSearch] = useState(o.initialSearch ?? "");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(o.initialHidden ?? []));
  const [widths, setWidths] = useState<Record<string, number>>(() => ({ ...(o.initialWidths ?? {}) }));
  const [views, setViews] = useState<SavedView[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const gridKey = o.gridKey;
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (loadedFor.current === gridKey) return;
    loadedFor.current = gridKey;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/grid-views?grid=${encodeURIComponent(gridKey)}`);
        const body = await res.json();
        if (alive && body?.ok && Array.isArray(body.data)) {
          setViews(body.data.map((v: SavedView) => ({ id: v.id, name: v.name, config: v.config })));
        }
      } catch {
        /* views are a convenience; ignore load failures */
      }
    })();
    return () => {
      alive = false;
    };
  }, [gridKey]);

  const setFilter = useCallback((key: string, patch: Partial<ColumnFilter> | null) => {
    setFilters((prev) => {
      if (patch === null) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: { ...prev[key], ...patch } };
    });
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({});
    setSearch("");
  }, []);

  const toggleSort = useCallback((key: string, additive: boolean) => {
    setSort((prev) => toggleSortState(prev, key, additive));
  }, []);

  // Deliberate sort chosen from a header menu — replaces the sort with a single
  // level (or clears it). Unlike toggleSort, a header click never sorts by itself.
  const sortColumn = useCallback((key: string, dir: "asc" | "desc" | null) => {
    setSort(dir === null ? [] : [{ key, dir }]);
  }, []);

  const toggleHidden = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const resetHidden = useCallback(() => setHidden(new Set(o.initialHidden ?? [])), [o.initialHidden]);

  const setWidth = useCallback((key: string, w: number) => {
    setWidths((prev) => ({ ...prev, [key]: w }));
  }, []);

  const columns = o.columns;
  const rows = o.rows;

  const visibleColumns = useMemo(() => columns.filter((c) => !hidden.has(c.key)), [columns, hidden]);

  const filtered = useMemo(
    () => applyFilters(rows, columns, filters, search, searchKeys),
    [rows, columns, filters, search, searchKeys],
  );
  const sorted = useMemo(() => sortRows(filtered, columns, sort), [filtered, columns, sort]);
  const totals = useMemo(() => (o.computeTotals ? o.computeTotals(filtered) : null), [o, filtered]);

  const chips = useMemo(() => filterChipsFor(columns, filters), [columns, filters]);
  const activeFilterColumns = useMemo(
    () => columns.filter((c) => filterActive(c, filters[c.key])),
    [columns, filters],
  );
  const anyFilter = useMemo(() => anyFilterActive(columns, filters, search), [columns, filters, search]);

  const valueCounts = useCallback(
    (key: string) => valueCountsFor(columns, rows, filters, search, searchKeys, key),
    [columns, rows, filters, search, searchKeys],
  );

  const currentConfig = useCallback((): GridViewConfig => {
    const cfg: GridViewConfig = { filters, sort, search };
    if (o.serializeHidden) cfg.hidden = [...hidden];
    if (o.serializeWidths) cfg.widths = widths;
    return cfg;
  }, [filters, sort, search, hidden, widths, o.serializeHidden, o.serializeWidths]);

  const applyView = useCallback(
    (cfg: GridViewConfig) => {
      setFilters(cfg.filters ?? {});
      setSort(cfg.sort ?? []);
      setSearch(cfg.search ?? "");
      if (o.serializeHidden) setHidden(new Set(cfg.hidden ?? []));
      if (o.serializeWidths && cfg.widths) setWidths({ ...(o.initialWidths ?? {}), ...cfg.widths });
    },
    [o.serializeHidden, o.serializeWidths, o.initialWidths],
  );

  const saveView = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch("/api/grid-views", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gridKey, name: trimmed, config: currentConfig() }),
        });
        const body = await res.json();
        if (!res.ok || !body?.ok) {
          setNotice(body?.error ?? "Could not save the view.");
          return;
        }
        const saved: SavedView = { id: body.data.id, name: body.data.name, config: body.data.config };
        setViews((prev) => {
          const rest = prev.filter((v) => v.name !== saved.name);
          return [...rest, saved].sort((a, b) => a.name.localeCompare(b.name));
        });
        setNotice(`Saved view “${saved.name}”.`);
      } catch {
        setNotice("Could not save the view.");
      } finally {
        setBusy(false);
      }
    },
    [gridKey, currentConfig],
  );

  const deleteView = useCallback(
    async (v: SavedView) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch(`/api/grid-views/${encodeURIComponent(v.id)}?grid=${encodeURIComponent(gridKey)}`, {
          method: "DELETE",
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body?.ok) {
          setNotice(body?.error ?? "Could not delete the view.");
          return;
        }
        setViews((prev) => prev.filter((x) => x.id !== v.id));
      } catch {
        setNotice("Could not delete the view.");
      } finally {
        setBusy(false);
      }
    },
    [gridKey],
  );

  const exportView = useCallback(
    async (format: "csv" | "xlsx", meta: { endpoint: string; title: string; filename: string }) => {
      setBusy(true);
      setNotice(null);
      try {
        const cols = o.exportAllColumns ? columns : visibleColumns;
        const res = await fetch(meta.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            format,
            title: meta.title,
            filename: meta.filename,
            columns: exportColumns(cols),
            rows: exportRows(cols, sorted),
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setNotice(body?.error ?? "Could not export.");
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${meta.filename}-${new Date().toISOString().slice(0, 10)}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch {
        setNotice("Could not export.");
      } finally {
        setBusy(false);
      }
    },
    [o.exportAllColumns, columns, visibleColumns, sorted],
  );

  return {
    canManage: o.canManage,
    columns,
    visibleColumns,
    filters,
    setFilter,
    clearFilters,
    sort,
    toggleSort,
    sortColumn,
    search,
    setSearch,
    hidden,
    toggleHidden,
    resetHidden,
    widths,
    setWidth,
    filtered,
    sorted,
    totals,
    totalCount: rows.length,
    resultCount: filtered.length,
    anyFilter,
    chips,
    activeFilterColumns,
    valueCounts,
    views,
    saveView,
    deleteView,
    applyView,
    currentConfig,
    exportView,
    busy,
    notice,
    setNotice,
  };
}
