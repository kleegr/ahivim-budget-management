"use client";

import { useState } from "react";
import type { ColumnDef, ColumnFilter, ValueCount } from "./types";
import { isNumericKind, isDateKind } from "./types";
import { filterActive } from "./engine";
import type { UseGridResult } from "./use-grid";

/** The salvaged filter body — now controlled, so applying a saved view is visible. */
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
  const selected = new Set(filter?.selected ?? []);
  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange({ selected: [...next] });
  };

  return (
    <div className="w-64 space-y-2">
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
            type="text"
            placeholder="Contains…"
            className="input w-full"
            value={filter?.contains ?? ""}
            onChange={(e) => onChange({ contains: e.target.value })}
          />
          <div className="flex items-center justify-between text-xs">
            <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => onChange({ selected: values.map((v) => v[0]) })}>
              Select all
            </button>
            <button type="button" className="text-[var(--color-ink-faint)] hover:underline" onClick={() => onChange({ selected: [] })}>
              Clear
            </button>
          </div>
          <div className="scroll-thin max-h-48 space-y-0.5 overflow-auto rounded border border-[var(--color-rule)] p-1">
            {values.length === 0 ? (
              <p className="px-1 py-2 text-xs text-[var(--color-ink-faint)]">No values</p>
            ) : (
              values.map(([v, n]) => (
                <label key={v} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-[var(--color-surface-strong)]">
                  <input type="checkbox" checked={selected.size > 0 && selected.has(v)} onChange={() => toggle(v)} />
                  <span className="flex-1 truncate">{v || "(blank)"}</span>
                  <span className="tnum text-xs text-[var(--color-ink-faint)]">{n}</span>
                </label>
              ))
            )}
          </div>
        </>
      )}
      <div className="flex justify-between border-t border-[var(--color-rule)] pt-2 text-xs">
        <button type="button" className="text-[var(--color-danger)] hover:underline" onClick={onClear}>
          Clear filter
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
          <div className="absolute left-0 top-full z-50 mt-1 rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-2 shadow-lg">
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
