"use client";

import { useMemo, useState } from "react";
import type { ColumnDef, ColumnFilter, ValueCount } from "./types";
import { isNumericKind, isDateKind } from "./types";
import { filterActive } from "./engine";
import type { UseGridResult } from "./use-grid";

/**
 * A column filter that behaves like the one in Google Sheets:
 *   - a search box that filters the list of values (not the rows),
 *   - a checkbox per distinct value with its live count,
 *   - Select all / Clear all that act on whatever the search is showing,
 *   - "Only" to isolate a single value in one click.
 *
 * The value list already reflects every OTHER active filter, so what you see is
 * what is actually selectable given the rest of the view. `selected === undefined`
 * means "all" (no constraint); an explicit (even empty) array means "exactly these".
 */
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

  const allVals = useMemo(() => values.map((v) => v[0]), [values]);
  const sel = filter?.selected; // undefined = all
  const selectedSet = useMemo(() => (sel === undefined ? null : new Set(sel)), [sel]);
  const isChecked = (v: string) => (selectedSet === null ? true : selectedSet.has(v));

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return values;
    return values.filter(([v]) => (v || "(blank)").toLowerCase().includes(needle));
  }, [values, q]);

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
      {isNumericKind(col.kind) ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs">
            <span className="text-[var(--color-ink-faint)]">Min</span>
            <input
              type="number"
              className="input mt-1 w-full"
              value={filter?.min ?? ""}
              onChange={(e) => onChange({ min: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            <span className="text-[var(--color-ink-faint)]">Max</span>
            <input
              type="number"
              className="input mt-1 w-full"
              value={filter?.max ?? ""}
              onChange={(e) => onChange({ max: e.target.value })}
            />
          </label>
        </div>
      ) : isDateKind(col.kind) ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs">
            <span className="text-[var(--color-ink-faint)]">From</span>
            <input
              type="date"
              className="input mt-1 w-full"
              value={filter?.from ?? ""}
              onChange={(e) => onChange({ from: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            <span className="text-[var(--color-ink-faint)]">To</span>
            <input
              type="date"
              className="input mt-1 w-full"
              value={filter?.to ?? ""}
              onChange={(e) => onChange({ to: e.target.value })}
            />
          </label>
        </div>
      ) : (
        <>
          <input
            type="search"
            placeholder="Search values…"
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
                  <span className="flex-1 truncate">{v || "(blank)"}</span>
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
        </>
      )}
      <div className="flex justify-between border-t border-[var(--color-rule)] pt-2 text-xs">
        <button type="button" className="text-[var(--color-danger)] hover:underline" onClick={onClear}>
          Remove filter
        </button>
      </div>
    </div>
  );
}

function FilterPill<Row, T>({ grid, col }: { grid: UseGridResult<Row, T>; col: ColumnDef<Row> }) {
  const [open, setOpen] = useState(false);
  const active = filterActive(col, grid.filters[col.key]);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
          active
            ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
            : "border-[var(--color-rule-strong)] bg-[var(--color-surface)] text-[var(--color-ink-soft)] hover:border-[var(--color-primary)] hover:text-[var(--color-ink)]"
        }`}
        aria-expanded={open}
      >
        {col.label}
        <span aria-hidden className="opacity-70">
          ▾
        </span>
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            className="absolute left-0 top-full z-50 mt-1 rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-2 shadow-lg"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
            }}
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
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * A visible filter bar: one obvious control per filterable column, a row of
 * active-filter chips you can dismiss, and a live result count. No more hunting
 * for a tiny caret.
 */
export function FilterBar<Row, T>({ grid }: { grid: UseGridResult<Row, T> }) {
  const filterable = grid.visibleColumns.filter((c) => c.filterable !== false);
  return (
    <div className="mb-3 rounded-xl border border-[var(--color-rule)] bg-[var(--color-surface-muted)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="eyebrow mr-1">Filter</span>
        {filterable.map((col) => (
          <FilterPill key={col.key} grid={grid} col={col} />
        ))}
      </div>
      {grid.chips.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-[var(--color-rule)] pt-2">
          <span className="eyebrow mr-1">Active</span>
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
      ) : null}
    </div>
  );
}
