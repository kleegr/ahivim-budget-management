import type { ReactNode } from "react";
import type { ExportFieldType } from "@/lib/export/tabular";

/**
 * Shared data-grid vocabulary. One definition of a column, a filter, a sort and
 * a saved view — consumed by every grid in the app (Transactions, Projections,
 * Reports) so filtering, sorting, saved views, export and totals behave
 * identically everywhere. Each grid keeps its own row body (virtualization,
 * inline editing, drawers); only the engine and the toolbar/filter UI are shared.
 */

export type GridFieldKind =
  | "text"
  | "date"
  | "money"
  | "hours"
  | "int"
  | "percent"
  | "computed"
  | "badge"
  | "custom";

export type GridAlign = "left" | "right" | "center";

export interface CellCtx {
  editing: boolean;
  canManage: boolean;
}

export interface ColumnDef<Row> {
  key: string;
  label: string;
  kind: GridFieldKind;
  /** Raw string value used for filtering, sorting and export. Null = empty. */
  accessor: (r: Row) => string | null;
  /** Optional rich cell (links, badges, editable inputs). Falls back to text. */
  render?: (r: Row, text: string, ctx: CellCtx) => ReactNode;
  sortable?: boolean; // default true
  filterable?: boolean; // default true
  /** Default-hidden when true. */
  hidden?: boolean;
  frozen?: boolean;
  width?: number;
  align?: GridAlign;
  editable?: boolean;
  /** For an editable cell: map the new string value to a PATCH body fragment. */
  patch?: (v: string) => Record<string, unknown>;
  /** For an editable per-program hours column: the program id it edits. */
  programId?: string;
  exportType?: ExportFieldType;
  /** Placeholder for an empty cell ("" for spreadsheet grids, "—" for reports). */
  emptyText?: string;
  /** Decimal places for a percent cell (raw value is already a whole percent). */
  percentPlaces?: number;
  /** Map a raw value to a friendly label (e.g. payment recipient). */
  badgeLabels?: Record<string, string>;
}

export interface ColumnFilter {
  /** Chosen text values; empty/undefined means all. */
  selected?: string[];
  /** Case-insensitive substring. */
  contains?: string;
  /** Inclusive numeric bounds. */
  min?: string;
  max?: string;
  /** Inclusive ISO-date bounds (string compare). */
  from?: string;
  to?: string;
}

export type FilterState = Record<string, ColumnFilter>;

export interface SortKey {
  key: string;
  dir: "asc" | "desc";
}
export type SortState = SortKey[];

export type ValueCount = [string, number];

export interface SavedView {
  id: string;
  name: string;
  config: unknown;
}

export interface GridViewConfig {
  filters: FilterState;
  sort: SortState;
  search: string;
  hidden?: string[];
  widths?: Record<string, number>;
}

export interface FilterChip {
  key: string;
  label: string;
}

export function isNumericKind(k: GridFieldKind): boolean {
  return k === "money" || k === "hours" || k === "int" || k === "percent" || k === "computed";
}

export function isDateKind(k: GridFieldKind): boolean {
  return k === "date";
}

export function defaultExportType(k: GridFieldKind): ExportFieldType {
  switch (k) {
    case "badge":
    case "custom":
      return "text";
    case "computed":
      return "money";
    case "money":
      return "money";
    case "hours":
      return "hours";
    case "int":
      return "int";
    case "percent":
      return "percent";
    case "date":
      return "date";
    default:
      return "text";
  }
}
