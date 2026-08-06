import { dec, tryDec, formatMoney, formatHours } from "@/lib/money";
import type { ExportCell, ExportFieldType } from "@/lib/export/tabular";
import {
  type ColumnDef,
  type ColumnFilter,
  type FilterState,
  type SortState,
  type ValueCount,
  type FilterChip,
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
  if (isNumericKind(col.kind)) return (f.min ?? "") !== "" || (f.max ?? "") !== "";
  if (isDateKind(col.kind)) return Boolean(f.from || f.to);
  return (f.selected?.length ?? 0) > 0 || Boolean(f.contains);
}

export function passesFilter<Row>(col: ColumnDef<Row>, r: Row, f?: ColumnFilter): boolean {
  if (!f) return true;
  if (isNumericKind(col.kind)) {
    const hasMin = (f.min ?? "") !== "";
    const hasMax = (f.max ?? "") !== "";
    if (!hasMin && !hasMax) return true;
    const v = numValue(col, r);
    if (v === null) return false;
    if (hasMin && v < Number(f.min)) return false;
    if (hasMax && v > Number(f.max)) return false;
    return true;
  }
  if (isDateKind(col.kind)) {
    const raw = rawValue(col, r);
    if (f.from && raw < f.from) return false;
    if (f.to && raw > f.to) return false;
    return true;
  }
  const raw = rawValue(col, r);
  if (f.selected && f.selected.length > 0 && !f.selected.includes(raw)) return false;
  if (f.contains && !raw.toLowerCase().includes(f.contains.toLowerCase())) return false;
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
      let cmp = 0;
      if (isNumericKind(col.kind)) {
        const av = numValue(col, a.r);
        const bv = numValue(col, b.r);
        const an = av === null ? -Infinity : av;
        const bn = bv === null ? -Infinity : bv;
        cmp = an === bn ? 0 : an < bn ? -1 : 1;
      } else {
        cmp = rawValue(col, a.r).localeCompare(rawValue(col, b.r), undefined, { numeric: true });
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
  const tally = new Map<string, number>();
  for (const r of base) {
    const v = rawValue(col, r);
    tally.set(v, (tally.get(v) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
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
    if (isNumericKind(col.kind)) {
      const min = (f.min ?? "") !== "";
      const max = (f.max ?? "") !== "";
      const label = min && max ? `${col.label}: ${f.min}–${f.max}` : min ? `${col.label} ≥ ${f.min}` : `${col.label} ≤ ${f.max}`;
      chips.push({ key: col.key, label });
    } else if (isDateKind(col.kind)) {
      const label = f.from && f.to ? `${col.label}: ${f.from} → ${f.to}` : f.from ? `${col.label} ≥ ${f.from}` : `${col.label} ≤ ${f.to}`;
      chips.push({ key: col.key, label });
    } else {
      const parts: string[] = [];
      if (f.selected && f.selected.length > 0) {
        parts.push(f.selected.length <= 3 ? f.selected.map((v) => v || "(blank)").join(", ") : `${f.selected.length} selected`);
      }
      if (f.contains) parts.push(`“${f.contains}”`);
      chips.push({ key: col.key, label: `${col.label}: ${parts.join(" · ")}` });
    }
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
    for (const c of cols) out[c.key] = c.accessor(r);
    return out;
  });
}
