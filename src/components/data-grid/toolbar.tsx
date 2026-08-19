"use client";

import { useState, type ReactNode } from "react";
import type { GridViewConfig } from "./types";
import type { UseGridResult } from "./use-grid";

/**
 * The shared grid toolbar: search, a live "X of N" result count, one-click
 * reset, an optional column chooser, CSV/Excel export, and saved views — the
 * same controls on every grid so the experience is learned once.
 */
export function Toolbar<Row, T>({
  grid,
  searchPlaceholder = "Search…",
  exportEndpoint,
  exportTitle,
  exportFilename,
  showColumnChooser = true,
  extraActions,
}: {
  grid: UseGridResult<Row, T>;
  searchPlaceholder?: string;
  exportEndpoint: string;
  exportTitle: string;
  exportFilename: string;
  showColumnChooser?: boolean;
  extraActions?: ReactNode;
}) {
  const [colsOpen, setColsOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [viewName, setViewName] = useState("");

  const hiddenCount = grid.hidden.size;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <input
        type="search"
        value={grid.search}
        onChange={(e) => grid.setSearch(e.target.value)}
        placeholder={searchPlaceholder}
        className="input w-56"
        aria-label="Search"
      />

      <span className="text-sm text-[var(--color-ink-faint)]">
        <span className="tnum font-semibold text-[var(--color-ink)]">{grid.resultCount.toLocaleString()}</span>
        {" of "}
        <span className="tnum">{grid.totalCount.toLocaleString()}</span>
      </span>

      <button
        type="button"
        className="btn btn-sm btn-secondary"
        onClick={grid.clearFilters}
        disabled={!grid.anyFilter}
      >
        Reset filters
      </button>

      {showColumnChooser ? (
        <div className="relative">
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setColsOpen((v) => !v)} aria-expanded={colsOpen}>
            Columns{hiddenCount ? ` (${hiddenCount} hidden)` : ""}
          </button>
          {colsOpen ? (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setColsOpen(false)} aria-hidden />
              <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-2 shadow-lg">
                <p className="mb-1 px-1 text-[0.7rem] font-medium uppercase tracking-wide text-[var(--color-text-soft)]">Show, hide &amp; reorder</p>
                <div className="scroll-thin max-h-72 space-y-0.5 overflow-auto">
                  {grid.orderedColumns.map((c, i) => (
                    <div key={c.key} className="group flex items-center gap-1 rounded px-1 py-0.5 text-sm hover:bg-[var(--color-surface-strong)]">
                      <label className="flex flex-1 items-center gap-2 truncate">
                        <input type="checkbox" checked={!grid.hidden.has(c.key)} onChange={() => grid.toggleHidden(c.key)} />
                        <span className="flex-1 truncate">{c.label || "—"}</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => grid.moveColumn(c.key, -1)}
                        disabled={i === 0}
                        title="Move up (earlier)"
                        aria-label={`Move ${c.label} earlier`}
                        className="rounded px-1 text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] disabled:opacity-30"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => grid.moveColumn(c.key, 1)}
                        disabled={i === grid.orderedColumns.length - 1}
                        title="Move down (later)"
                        aria-label={`Move ${c.label} later`}
                        className="rounded px-1 text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] disabled:opacity-30"
                      >
                        ▼
                      </button>
                    </div>
                  ))}
                </div>
                <button type="button" className="mt-1 w-full text-xs text-[var(--color-ink-faint)] underline underline-offset-2" onClick={grid.resetHidden}>
                  Reset visible columns
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="relative">
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setViewsOpen((v) => !v)} aria-expanded={viewsOpen}>
          Saved views{grid.views.length ? ` (${grid.views.length})` : ""}
        </button>
        {viewsOpen ? (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setViewsOpen(false)} aria-hidden />
            <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-2 shadow-lg">
              {grid.views.length === 0 ? (
                <p className="px-1 py-1 text-xs text-[var(--color-ink-faint)]">No saved views yet.</p>
              ) : (
                <ul className="space-y-0.5">
                  {grid.views.map((v) => (
                    <li key={v.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        className="flex-1 truncate rounded px-2 py-1 text-left text-sm hover:bg-[var(--color-surface-strong)]"
                        onClick={() => {
                          grid.applyView(v.config as GridViewConfig);
                          setViewsOpen(false);
                        }}
                      >
                        {v.name}
                      </button>
                      {grid.canManage ? (
                        <button
                          type="button"
                          className="rounded px-1.5 py-1 text-xs text-[var(--color-ink-faint)] hover:text-[var(--color-danger)]"
                          onClick={() => grid.deleteView(v)}
                          aria-label={`Delete view ${v.name}`}
                        >
                          ✕
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {grid.canManage ? (
                <div className="mt-2 flex items-center gap-1 border-t border-[var(--color-rule)] pt-2">
                  <input
                    type="text"
                    value={viewName}
                    onChange={(e) => setViewName(e.target.value)}
                    placeholder="Name this view"
                    className="input w-full text-sm"
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={!viewName.trim() || grid.busy}
                    onClick={async () => {
                      await grid.saveView(viewName);
                      setViewName("");
                    }}
                  >
                    Save
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={grid.busy}
          onClick={() => grid.exportView("csv", { endpoint: exportEndpoint, title: exportTitle, filename: exportFilename })}
        >
          Export CSV
        </button>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={grid.busy}
          onClick={() => grid.exportView("xlsx", { endpoint: exportEndpoint, title: exportTitle, filename: exportFilename })}
        >
          Excel
        </button>
      </div>

      {extraActions}

      {grid.notice ? <span className="text-xs text-[var(--color-ink-faint)]">{grid.notice}</span> : null}
    </div>
  );
}
