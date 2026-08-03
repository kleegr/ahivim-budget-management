"use client";

import { useMemo } from "react";
import Link from "next/link";
import { dec, formatMoney, formatHours } from "@/lib/money";
import type { ReportCellRow, ReportTable } from "@/lib/data/report-queries";
import { type ColumnDef, isNumericKind } from "@/components/data-grid/types";
import { formatCell } from "@/components/data-grid/engine";
import { useGrid } from "@/components/data-grid/use-grid";
import { Toolbar } from "@/components/data-grid/toolbar";
import { FilterBar } from "@/components/data-grid/filter-bar";

/**
 * A report table on top of the shared data-grid engine. The adapter turns the
 * report's normalized columns into `ColumnDef`s; the engine owns filtering,
 * sorting, search, saved views and export; the Toolbar and FilterBar own their
 * UI. Only the row body and the filtered totals live here.
 */

/* -------------------------------------------------------------- entity links */

const INDIVIDUAL_KEYS = new Set(["individual", "individualName", "name"]);
const EMPLOYEE_KEYS = new Set(["employee", "employeeName"]);

const isEntityKey = (key: string): boolean => INDIVIDUAL_KEYS.has(key) || EMPLOYEE_KEYS.has(key);

/** Reproduces the original `idFor(row, col)`: link a name cell to its entity. */
function entityHref(row: ReportCellRow, key: string): string | null {
  if (INDIVIDUAL_KEYS.has(key) && row.individualId) return `/individuals/${String(row.individualId)}`;
  if (EMPLOYEE_KEYS.has(key) && row.employeeId) return `/employees/${String(row.employeeId)}`;
  return null;
}

/* ---------------------------------------------------------------- totals type */

interface ReportTotals {
  tiles: { key: string; header: string; label: string }[];
  rowCount: number;
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
  const columns = useMemo<ColumnDef<ReportCellRow>[]>(
    () =>
      table.columns.map((c) => {
        const col: ColumnDef<ReportCellRow> = {
          key: c.key,
          label: c.header,
          kind: c.type,
          accessor: (r) => (r[c.key] == null ? null : String(r[c.key])),
          emptyText: "—",
          percentPlaces: 1,
        };
        if (isEntityKey(c.key)) {
          col.render = (row, text) => {
            const href = entityHref(row, c.key);
            return href ? (
              <Link href={href} className="font-medium text-[var(--color-primary)] hover:underline">
                {text}
              </Link>
            ) : (
              text
            );
          };
        }
        return col;
      }),
    [table.columns],
  );

  const grid = useGrid<ReportCellRow, ReportTotals>({
    rows: table.rows,
    columns,
    gridKey: `report:${reportKey}`,
    canManage,
    initialSort: [],
    initialHidden: [],
    computeTotals: (filtered) => {
      const tiles = table.columns
        .filter((c) => c.type === "money" || c.type === "hours" || c.type === "int")
        .map((c) => {
          let sum = dec(0);
          for (const r of filtered) {
            const v = r[c.key];
            if (v === null || v === undefined || v === "") continue;
            try {
              sum = sum.plus(dec(v));
            } catch {
              /* skip an unparseable cell, exactly as before */
            }
          }
          const label =
            c.type === "money"
              ? formatMoney(sum.toFixed(2))
              : c.type === "hours"
                ? formatHours(sum.toFixed(2))
                : sum.toDecimalPlaces(0).toNumber().toLocaleString();
          return { key: c.key, header: c.header, label };
        });
      return { tiles, rowCount: filtered.length };
    },
    serializeHidden: true,
  });

  const tileCls = "rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2";

  return (
    <div className="space-y-3">
      {table.title ? (
        <h2 className="display text-[0.95rem] font-semibold text-[var(--color-ink)]">{table.title}</h2>
      ) : null}

      <Toolbar
        grid={grid}
        searchPlaceholder="Search this report…"
        exportEndpoint="/api/grid/export"
        exportTitle={table.title ?? "Report"}
        exportFilename={reportKey}
        showColumnChooser
      />

      <FilterBar grid={grid} />

      {/* filtered totals */}
      {grid.totals ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {grid.totals.tiles.map((t) => (
            <div key={t.key} className={tileCls}>
              <div className="eyebrow text-[var(--color-ink-faint)]">{t.header}</div>
              <div className="tnum text-lg font-semibold">{t.label}</div>
            </div>
          ))}
          <div className={tileCls}>
            <div className="eyebrow text-[var(--color-ink-faint)]"># Rows</div>
            <div className="tnum text-lg font-semibold">{grid.totals.rowCount.toLocaleString()}</div>
          </div>
        </div>
      ) : null}

      {/* grid */}
      <div className="scroll-thin max-h-[62vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-20">
            <tr>
              {grid.visibleColumns.map((col) => {
                const idx = grid.sort.findIndex((s) => s.key === col.key);
                const active = grid.sort[idx];
                return (
                  <th
                    key={col.key}
                    aria-sort={active ? (active.dir === "asc" ? "ascending" : "descending") : "none"}
                    className="border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-2 py-1.5 text-left align-bottom font-semibold whitespace-nowrap"
                  >
                    <button
                      type="button"
                      className="flex w-full items-center gap-1 text-left hover:underline"
                      title="Click to sort, Shift-click to add a sort level"
                      onClick={(e) => grid.toggleSort(col.key, e.shiftKey)}
                    >
                      <span className="flex-1 truncate">{col.label}</span>
                      {active ? (
                        <span className="text-[10px] text-[var(--color-primary)]">
                          {active.dir === "asc" ? "▲" : "▼"}
                          {grid.sort.length > 1 ? idx + 1 : ""}
                        </span>
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {grid.sorted.map((row, i) => (
              <tr key={i} className="hover:bg-black/[0.03]">
                {grid.visibleColumns.map((col) => {
                  const numeric = isNumericKind(col.kind);
                  const text = formatCell(col, row);
                  return (
                    <td
                      key={col.key}
                      className={`whitespace-nowrap border-b border-r border-[var(--color-rule)] px-2 py-1 ${
                        numeric ? "text-right tnum" : "text-left"
                      }`}
                    >
                      {col.render ? col.render(row, text, { editing: false, canManage }) : text}
                    </td>
                  );
                })}
              </tr>
            ))}
            {grid.sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={grid.visibleColumns.length}
                  className="px-3 py-10 text-center text-[var(--color-ink-faint)]"
                >
                  {table.emptyMessage ?? "No rows match the current filters."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
