"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ColumnDef, ColumnFilter, DateGroup, ValueCount } from "./types";
import { isNumericKind, isDateKind } from "./types";
import { filterActive } from "./engine";
import type { UseGridResult } from "./use-grid";

/**
 * Google-Sheets-style column filtering. Every column — text, number OR date —
 * gets the same popover:
 *   - a search box that filters the list of values (not the rows),
 *   - a checkbox per distinct value with its live count,
 *   - Select all / Clear all that act on whatever the search is showing,
 *   - "Only" to isolate a single value in one click,
 *   - for dates, a Day / Month / Year switch so "everything in 2026" is one tick,
 *   - for numbers and dates, an optional exact range on top of the ticks.
 *
 * The value list already reflects every OTHER active filter, so what you see is
 * what is actually selectable given the rest of the view. `selected === undefined`
 * means "all" (no constraint); an explicit (even empty) array means "exactly these".
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A friendly label for a value in the checkbox list (dates get humanised). */
function labelForValue<Row>(col: ColumnDef<Row>, v: string, group: DateGroup): string {
  if (isDateKind(col.kind)) {
    if (!v) return "(no date)";
    if (group === "year") return v; // "2026"
    if (group === "month") {
      const [y, m] = v.split("-");
      return `${MONTHS[Number(m) - 1] ?? m} ${y}`; // "Aug 2026"
    }
    const [y, m, d] = v.split("-");
    return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}, ${y}`; // "Aug 18, 2026"
  }
  return v || "(blank)";
}

function GroupToggle({ value, onChange }: { value: DateGroup; onChange: (g: DateGroup) => void }) {
  const opts: { k: DateGroup; label: string }[] = [
    { k: "day", label: "Day" },
    { k: "month", label: "Month" },
    { k: "year", label: "Year" },
  ];
  return (
    <div className="inline-flex w-full rounded-md border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-0.5 text-xs">
      {opts.map((o) => (
        <button
          key={o.k}
          type="button"
          onClick={() => onChange(o.k)}
          aria-pressed={value === o.k}
          className={`flex-1 rounded px-2 py-1 font-medium transition-colors ${
            value === o.k ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ColumnFilterControl<Row>({
  col,
  filter,
  values,
  onChange,
  onClear,
}: {
  col: ColumnDef<Row>;
  filter?: ColumnFilter;
  values: ValueCount[];
  onChange: (patch: Partial<ColumnFilter>) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState("");
  const isDate = isDateKind(col.kind);
  const isNum = isNumericKind(col.kind);
  const dateGroup: DateGroup = filter?.dateGroup ?? "day";
  const hasRange = isNum ? (filter?.min ?? "") !== "" || (filter?.max ?? "") !== "" : (filter?.from ?? "") !== "" || (filter?.to ?? "") !== "";
  const [showRange, setShowRange] = useState(hasRange);

  const allVals = useMemo(() => values.map((v) => v[0]), [values]);
  const sel = filter?.selected; // undefined = all
  const selectedSet = useMemo(() => (sel === undefined ? null : new Set(sel)), [sel]);
  const isChecked = (v: string) => (selectedSet === null ? true : selectedSet.has(v));

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return values;
    return values.filter(
      ([v]) => v.toLowerCase().includes(needle) || labelForValue(col, v, dateGroup).toLowerCase().includes(needle),
    );
  }, [values, q, col, dateGroup]);

  // Fold a set change back into a patch: full set -> "all", otherwise the array.
  const commit = (nextSet: Set<string>) => {
    if (nextSet.size === allVals.length) onChange({ selected: undefined });
    else onChange({ selected: [...nextSet] });
  };
  const baseSet = () => (selectedSet === null ? new Set(allVals) : new Set(selectedSet));

  const toggle = (v: string) => {
    const next = baseSet();
    if (next.has(v)) next.delete(v);
    else next.add(v);
    commit(next);
  };
  const only = (v: string) => onChange({ selected: [v] });
  const selectAllVisible = () => {
    if (!q.trim()) return onChange({ selected: undefined }); // all
    const next = baseSet();
    for (const [v] of visible) next.add(v);
    commit(next);
  };
  const clearVisible = () => {
    if (!q.trim()) return onChange({ selected: [] }); // none
    const next = baseSet();
    for (const [v] of visible) next.delete(v);
    onChange({ selected: [...next] });
  };

  const selectedCount = selectedSet === null ? allVals.length : selectedSet.size;

  return (
    <div className="w-72 space-y-2">
      {isDate ? (
        // Switching granularity re-buckets the list, so the old ticks no longer
        // mean anything — reset to "all" when the grouping changes.
        <GroupToggle value={dateGroup} onChange={(g) => onChange({ dateGroup: g, selected: undefined })} />
      ) : null}

      <input
        type="search"
        placeholder={isDate ? "Search dates…" : isNum ? "Search values…" : `Search ${col.label.toLowerCase()}…`}
        className="input w-full"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label={`Search ${col.label} values`}
      />

      <div className="flex items-center justify-between text-xs">
        <div className="flex gap-2">
          <button type="button" className="font-medium text-[var(--color-primary)] hover:underline" onClick={selectAllVisible}>
            {q.trim() ? "Select shown" : "Select all"}
          </button>
          <button type="button" className="text-[var(--color-ink-faint)] hover:underline" onClick={clearVisible}>
            {q.trim() ? "Clear shown" : "Clear all"}
          </button>
        </div>
        <span className="tnum text-[var(--color-ink-faint)]">
          {selectedCount}/{allVals.length}
        </span>
      </div>

      <div className="scroll-thin max-h-56 space-y-0.5 overflow-auto rounded border border-[var(--color-rule)] p-1">
        {visible.length === 0 ? (
          <p className="px-1 py-2 text-xs text-[var(--color-ink-faint)]">No matching values</p>
        ) : (
          visible.map(([v, n]) => (
            <label key={v} className="group flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-[var(--color-surface-strong)]">
              <input type="checkbox" checked={isChecked(v)} onChange={() => toggle(v)} />
              <span className="flex-1 truncate">{labelForValue(col, v, dateGroup)}</span>
              <button
                type="button"
                className="hidden text-[0.65rem] font-medium text-[var(--color-primary)] hover:underline group-hover:inline"
                onClick={(e) => {
                  e.preventDefault();
                  only(v);
                }}
              >
                only
              </button>
              <span className="tnum text-xs text-[var(--color-ink-faint)]">{n}</span>
            </label>
          ))
        )}
      </div>

      {isNum || isDate ? (
        <div className="rounded border border-[var(--color-rule)]">
          <button
            type="button"
            onClick={() => setShowRange((v) => !v)}
            className="flex w-full items-center justify-between px-2 py-1 text-xs font-medium text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
            aria-expanded={showRange}
          >
            <span>{isDate ? "Exact date range" : "Exact number range"}</span>
            <span aria-hidden>{showRange ? "▾" : "▸"}</span>
          </button>
          {showRange ? (
            <div className="grid grid-cols-2 gap-2 border-t border-[var(--color-rule)] p-2">
              {isNum ? (
                <>
                  <label className="block text-xs">
                    <span className="text-[var(--color-ink-faint)]">Min</span>
                    <input type="number" className="input mt-1 w-full" value={filter?.min ?? ""} onChange={(e) => onChange({ min: e.target.value })} />
                  </label>
                  <label className="block text-xs">
                    <span className="text-[var(--color-ink-faint)]">Max</span>
                    <input type="number" className="input mt-1 w-full" value={filter?.max ?? ""} onChange={(e) => onChange({ max: e.target.value })} />
                  </label>
                </>
              ) : (
                <>
                  <label className="block text-xs">
                    <span className="text-[var(--color-ink-faint)]">From</span>
                    <input type="date" className="input mt-1 w-full" value={filter?.from ?? ""} onChange={(e) => onChange({ from: e.target.value })} />
                  </label>
                  <label className="block text-xs">
                    <span className="text-[var(--color-ink-faint)]">To</span>
                    <input type="date" className="input mt-1 w-full" value={filter?.to ?? ""} onChange={(e) => onChange({ to: e.target.value })} />
                  </label>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-end border-t border-[var(--color-rule)] pt-2 text-xs">
        <button type="button" className="text-[var(--color-danger)] hover:underline" onClick={onClear}>
          Remove filter
        </button>
      </div>
    </div>
  );
}

function FunnelIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden className="shrink-0">
      <path
        d="M2 3h12l-4.5 5.5V13L6.5 11.5V8.5L2 3z"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The filter affordance that lives ON a column header — a funnel you click to
 * open the value picker right where the column is, exactly like Google Sheets.
 * Faint until the column is filtered, then it lights up.
 *
 * The popover is rendered in a portal with fixed positioning anchored to the
 * funnel, so it escapes the grid's own `overflow:auto` clipping and the sticky
 * header's stacking context (both would otherwise trap or hide it).
 */
const POPOVER_WIDTH = 288; // matches the w-72 control

export function HeaderFilter<Row, T>({ grid, col }: { grid: UseGridResult<Row, T>; col: ColumnDef<Row> }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      let left = b.right - POPOVER_WIDTH; // right-align the popover to the funnel
      left = Math.max(8, Math.min(left, window.innerWidth - POPOVER_WIDTH - 8));
      setPos({ top: b.bottom + 4, left });
    };
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  if (col.filterable === false) return null;
  const active = filterActive(col, grid.filters[col.key]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation(); // don't trigger the header's sort handler
          setOpen((v) => !v);
        }}
        title={`Filter ${col.label}`}
        aria-label={`Filter ${col.label}`}
        aria-expanded={open}
        className={`grid h-5 w-5 place-items-center rounded transition-colors ${
          active
            ? "bg-[var(--color-primary)] text-white"
            : "text-[var(--color-ink-faint)] opacity-60 hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)] hover:opacity-100"
        }`}
      >
        <FunnelIcon active={active} />
      </button>
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popRef}
              className="pop-in fixed z-[70] origin-top rounded-xl border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-2 shadow-lg"
              style={{ top: pos.top, left: pos.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <ColumnFilterControl
                col={col}
                filter={grid.filters[col.key]}
                values={grid.valueCounts(col.key)}
                onChange={(patch) => grid.setFilter(col.key, patch)}
                onClear={() => {
                  grid.setFilter(col.key, null);
                  setOpen(false);
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * A slim summary of the filters currently in force, with one-click removal and
 * a Clear-all. The controls to ADD a filter now live on the column headers
 * (the funnels), so this only appears when something is actually filtered.
 */
export function FilterBar<Row, T>({ grid }: { grid: UseGridResult<Row, T> }) {
  if (grid.chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-3 py-2">
      <span className="eyebrow mr-1">Filters</span>
      {grid.chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => grid.setFilter(chip.key, null)}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-primary-tint)] px-2.5 py-1 text-xs font-medium text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary-soft)]"
          title="Remove filter"
        >
          {chip.label}
          <span aria-hidden>✕</span>
        </button>
      ))}
      <button
        type="button"
        onClick={grid.clearFilters}
        className="ml-1 text-xs text-[var(--color-ink-faint)] underline underline-offset-2 hover:text-[var(--color-ink)]"
      >
        Clear all
      </button>
    </div>
  );
}
