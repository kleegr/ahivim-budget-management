import { dec, tryDec, formatMoney, formatHours } from "@/lib/money";
import type { ExportCell, ExportFieldType } from "@/lib/export/tabular";
import {
  type ColumnDef,
  type ColumnFilter,
  type FilterState,
  type SortState,
  type ValueCount,
  type FilterChip,
  type DateGroup,
  isNumericKind,
  isDateKind,
  defaultExportType,
} from "./types";

/**
 * Pure, React-free grid engine. One definition of "filter", "sort", "search",
 * "value counts" and "export payload" — every grid runs on exactly this, so a
 * saved view built in one place behaves the same everywhere. Money and hours
 * stay decimal-safe (decimal.js); Number is used only for comparison keys.
 */

export function rawValue<Row>(col: ColumnDef<Row>, r: Row): string {
  return col.accessor(r) ?? "";
}

export function numValue<Row>(col: ColumnDef<Row>, r: Row): number | null {
  const d = tryDec(col.accessor(r));
  return d === null ? null : d.toNumber();
}

/** Bucket an ISO date ("YYYY-MM-DD") to the chosen granularity for value lists. */
export function dateBucket(iso: string, group: DateGroup): string {
  if (!iso) return "";
  if (group === "year") return iso.slice(0, 4);
  if (group === "month") return iso.slice(0, 7);
  return iso.slice(0, 10);
}

/**
 * The canonical value a checkbox filter matches on, per column kind:
 *   text/badge -> the raw string
 *   number     -> a canonical numeric string ("21.0000" and "21" collapse)
 *   date       -> the bucket at `dateGroup` ("2026", "2026-08", "2026-08-18")
 * Both the value list and row matching go through this, so they always agree.
 */
export function filterKey<Row>(col: ColumnDef<Row>, r: Row, dateGroup?: DateGroup): string {
  const raw = rawValue(col, r);
  if (isDateKind(col.kind)) return dateBucket(raw, dateGroup ?? "day");
  if (isNumericKind(col.kind)) {
    const d = tryDec(raw);
    return d === null ? raw : d.toString();
  }
  return raw;
}

export function formatCell<Row>(col: ColumnDef<Row>, r: Row): string {
  const raw = col.accessor(r);
  if (raw === null || raw === "") return col.emptyText ?? "";
  switch (col.kind) {
    case "money":
    case "computed":
      return formatMoney(raw);
    case "hours":
      return formatHours(raw);
    case "percent":
      return col.percentPlaces != null
        ? `${dec(raw).toDecimalPlaces(col.percentPlaces)}%`
        : `${raw}%`;
    case "int": {
      const n = Number(raw);
      return Number.isFinite(n) ? n.toLocaleString() : raw;
    }
    case "badge":
      return col.badgeLabels?.[raw] ?? raw;
    default:
      return raw;
  }
}

export function filterActive<Row>(col: ColumnDef<Row>, f?: ColumnFilter): boolean {
  if (!f) return false;
  // A `selected` array that is *present* is an active filter for ANY column —
  // even when empty, which means "show none" (Google-Sheets "Clear all").
  if (f.selected !== undefined) return true;
  if (isNumericKind(col.kind)) return (f.min ?? "") !== "" || (f.max ?? "") !== "";
  if (isDateKind(col.kind)) return Boolean(f.from || f.to);
  return Boolean(f.contains);
}

export function passesFilter<Row>(col: ColumnDef<Row>, r: Row, f?: ColumnFilter): boolean {
  if (!f) return true;
  // Checkbox value-set selection now applies to every column kind. A present
  // `selected` (even empty) constrains to exactly that set of buckets/values.
  if (f.selected !== undefined) {
    const key = filterKey(col, r, f.dateGroup);
    if (!f.selected.includes(key)) return false;
  }
  // Range / substring constraints AND on top of the value selection.
  if (isNumericKind(col.kind)) {
    const hasMin = (f.min ?? "") !== "";
    const hasMax = (f.max ?? "") !== "";
    if (hasMin || hasMax) {
      const v = numValue(col, r);
      if (v === null) return false;
      if (hasMin && v < Number(f.min)) return false;
      if (hasMax && v > Number(f.max)) return false;
    }
  } else if (isDateKind(col.kind)) {
    const raw = rawValue(col, r);
    if (f.from && raw < f.from) return false;
    if (f.to && raw > f.to) return false;
  } else if (f.contains) {
    if (!rawValue(col, r).toLowerCase().includes(f.contains.toLowerCase())) return false;
  }
  return true;
}

function matchesSearch<Row>(
  r: Row,
  colByKey: Map<string, ColumnDef<Row>>,
  searchKeys: string[],
  search: string,
): boolean {
  const q = search.trim().toLowerCase();
  if (q === "") return true;
  for (const k of searchKeys) {
    const col = colByKey.get(k);
    if (!col) continue;
    if ((col.accessor(r) ?? "").toLowerCase().includes(q)) return true;
  }
  return false;
}

export function applyFilters<Row>(
  rows: Row[],
  cols: ColumnDef<Row>[],
  filters: FilterState,
  search: string,
  searchKeys: string[],
  exceptKey?: string,
): Row[] {
  const colByKey = new Map(cols.map((c) => [c.key, c]));
  const active = cols.filter(
    (c) => c.filterable !== false && c.key !== exceptKey && filterActive(c, filters[c.key]),
  );
  return rows.filter((r) => {
    if (!matchesSearch(r, colByKey, searchKeys, search)) return false;
    for (const c of active) {
      if (!passesFilter(c, r, filters[c.key])) return false;
    }
    return true;
  });
}

export function sortRows<Row>(rows: Row[], cols: ColumnDef<Row>[], sort: SortState): Row[] {
  if (sort.length === 0) return rows;
  const colByKey = new Map(cols.map((c) => [c.key, c]));
  const decorated = rows.map((r, i) => ({ r, i }));
  decorated.sort((a, b) => {
    for (const s of sort) {
      const col = colByKey.get(s.key);
      if (!col) continue;
      const sortValue = col.sortAccessor ?? col.accessor;
      let cmp = 0;
      if (isNumericKind(col.kind)) {
        const avDecimal = tryDec(sortValue(a.r));
        const bvDecimal = tryDec(sortValue(b.r));
        const av = avDecimal === null ? null : avDecimal.toNumber();
        const bv = bvDecimal === null ? null : bvDecimal.toNumber();
        const an = av === null ? -Infinity : av;
        const bn = bv === null ? -Infinity : bv;
        cmp = an === bn ? 0 : an < bn ? -1 : 1;
      } else {
        cmp = (sortValue(a.r) ?? "").localeCompare(sortValue(b.r) ?? "", undefined, { numeric: true });
      }
      if (cmp !== 0) return s.dir === "desc" ? -cmp : cmp;
    }
    return a.i - b.i; // stable
  });
  return decorated.map((d) => d.r);
}

export function valueCountsFor<Row>(
  cols: ColumnDef<Row>[],
  rows: Row[],
  filters: FilterState,
  search: string,
  searchKeys: string[],
  key: string,
): ValueCount[] {
  const col = cols.find((c) => c.key === key);
  if (!col) return [];
  const base = applyFilters(rows, cols, filters, search, searchKeys, key);
  const dateGroup = filters[key]?.dateGroup;
  const tally = new Map<string, number>();
  for (const r of base) {
    const v = filterKey(col, r, dateGroup);
    tally.set(v, (tally.get(v) ?? 0) + 1);
  }
  const entries = [...tally.entries()];
  if (isDateKind(col.kind)) {
    // Newest first — the useful default for a date value list.
    entries.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  } else if (isNumericKind(col.kind)) {
    entries.sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0));
  } else {
    entries.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }
  return entries;
}

/** 3-state single-column cycle (asc → desc → none); shift adds/updates a level. */
export function toggleSortState(sort: SortState, key: string, additive: boolean): SortState {
  const existing = sort.find((s) => s.key === key);
  if (!additive) {
    if (!existing) return [{ key, dir: "asc" }];
    if (existing.dir === "asc") return [{ key, dir: "desc" }];
    return [];
  }
  if (!existing) return [...sort, { key, dir: "asc" }];
  if (existing.dir === "asc") return sort.map((s) => (s.key === key ? { key, dir: "desc" as const } : s));
  return sort.filter((s) => s.key !== key);
}

export function filterChips<Row>(cols: ColumnDef<Row>[], filters: FilterState): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const col of cols) {
    const f = filters[col.key];
    if (!filterActive(col, f) || !f) continue;
    const parts: string[] = [];
    // The value selection reads the same for every kind.
    if (f.selected !== undefined) {
      if (f.selected.length === 0) parts.push("none");
      else if (f.selected.length <= 3) parts.push(f.selected.map((v) => v || "(blank)").join(", "));
      else parts.push(`${f.selected.length} selected`);
    }
    if (isNumericKind(col.kind)) {
      const min = (f.min ?? "") !== "";
      const max = (f.max ?? "") !== "";
      if (min && max) parts.push(`${f.min}–${f.max}`);
      else if (min) parts.push(`≥ ${f.min}`);
      else if (max) parts.push(`≤ ${f.max}`);
    } else if (isDateKind(col.kind)) {
      if (f.from && f.to) parts.push(`${f.from} → ${f.to}`);
      else if (f.from) parts.push(`≥ ${f.from}`);
      else if (f.to) parts.push(`≤ ${f.to}`);
    } else if (f.contains) {
      parts.push(`“${f.contains}”`);
    }
    chips.push({ key: col.key, label: `${col.label}: ${parts.join(" · ") || "all"}` });
  }
  return chips;
}

export function anyFilterActive<Row>(cols: ColumnDef<Row>[], filters: FilterState, search: string): boolean {
  return search.trim() !== "" || cols.some((c) => filterActive(c, filters[c.key]));
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

export interface ExportRequestColumn {
  key: string;
  header: string;
  type: ExportFieldType;
}

export function exportColumns<Row>(cols: ColumnDef<Row>[]): ExportRequestColumn[] {
  return cols.map((c) => ({ key: c.key, header: c.label, type: c.exportType ?? defaultExportType(c.kind) }));
}

export function exportRows<Row>(cols: ColumnDef<Row>[], rows: Row[]): Record<string, ExportCell>[] {
  return rows.map((r) => {
    const out: Record<string, ExportCell> = {};
    for (const c of cols) out[c.key] = (c.exportAccessor ?? c.accessor)(r);
    return out;
  });
}
