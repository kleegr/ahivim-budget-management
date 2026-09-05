"use client";

import { useMemo } from "react";
import Link from "next/link";
import { dec, formatMoney, formatHours } from "@/lib/money";
import { computeGridTotals } from "@/lib/business/transaction-totals";
import type { ReportCell, ReportCellRow, ReportTable } from "@/lib/data/report-queries";
import { type ColumnDef, isNumericKind } from "@/components/data-grid/types";
import { formatCell } from "@/components/data-grid/engine";
import { useGrid } from "@/components/data-grid/use-grid";
import { Toolbar } from "@/components/data-grid/toolbar";
import { FilterBar, HeaderFilter } from "@/components/data-grid/filter-bar";

/**
 * A report table on top of the shared data-grid engine. The adapter turns the
 * report's normalized columns into `ColumnDef`s; the engine owns filtering,
 * sorting, search, saved views and export; the Toolbar and FilterBar own their
 * UI. Only the row body and the filtered totals live here.
 */

/* -------------------------------------------------------------- entity links */

const INDIVIDUAL_KEYS = new Set(["individual", "individualName", "name"]);
const EMPLOYEE_KEYS = new Set(["employee", "employeeName"]);
const SOURCE_KEYS = new Set(["transactionId", "statementSource"]);

const isEntityKey = (key: string): boolean =>
  INDIVIDUAL_KEYS.has(key) || EMPLOYEE_KEYS.has(key) || SOURCE_KEYS.has(key);

/** Reproduces the original `idFor(row, col)`: link a name cell to its entity. */
function entityHref(row: ReportCellRow, key: string): string | null {
  if (INDIVIDUAL_KEYS.has(key) && row.individualId) return `/individuals/${String(row.individualId)}`;
  if (EMPLOYEE_KEYS.has(key) && row.employeeId) return `/employees/${String(row.employeeId)}`;
  if (key === "transactionId" && row.transactionId) {
    return `/transactions?transactionId=${encodeURIComponent(String(row.transactionId))}`;
  }
  if (key === "statementSource" && row.statementSource) {
    const month = row.reportMonth ? `?month=${encodeURIComponent(String(row.reportMonth))}` : "";
    return `/masser/individuals/${encodeURIComponent(String(row.statementSource))}${month}`;
  }
  return null;
}

function sourceCellLabel(key: string, fallback: string): string {
  if (key === "transactionId") return "Open transaction";
  if (key === "statementSource") return "View statement";
  return fallback;
}

function totalsSource(
  rows: ReportCellRow[],
  reportKey: string,
  tableSource: ReportTable["source"],
): { href: string; label: string } | null {
  // Keep the underlying source reachable even when a report is empty. An
  // empty result is still something an operator may need to verify at source.
  if (rows.length === 0) return tableSource ?? null;
  if (reportKey === "payroll-checks") {
    const ids = [...new Set(rows.map((row) => row.transactionId).filter((id): id is string => typeof id === "string"))];
    if (ids.length === rows.length && ids.length <= 75) {
      const query = new URLSearchParams();
      for (const id of ids) query.append("transactionId", id);
      return { href: `/transactions?${query}`, label: `Open ${ids.length.toLocaleString()} exact source row${ids.length === 1 ? "" : "s"}` };
    }
    return tableSource ?? null;
  }
  if (reportKey === "individual-put-away") {
    if (rows.length === 1 && typeof rows[0]?.statementSource === "string") {
      return {
        href: entityHref(rows[0], "statementSource")!,
        label: "Open the source statement",
      };
    }
    const month = rows.find((row) => typeof row.reportMonth === "string")?.reportMonth;
    return {
      href: `/masser${month ? `?month=${encodeURIComponent(String(month))}` : ""}`,
      label: "Open the source Money workspace",
    };
  }
  return tableSource ?? null;
}

/* ---------------------------------------------------------------- totals type */

interface ReportTotals {
  tiles: { key: string; header: string; label: string }[];
  rowCount: number;
  source: { href: string; label: string } | null;
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
        if (c.linkLabel) {
          col.render = (row, text) => {
            const value = row[c.key];
            const href = typeof value === "string" && value.startsWith("/") ? value : null;
            return href ? (
              <Link href={href} className="font-medium text-[var(--color-primary)] hover:underline">
                {c.linkLabel}
              </Link>
            ) : text;
          };
        } else if (isEntityKey(c.key)) {
          col.render = (row, text) => {
            const href = entityHref(row, c.key);
            return href ? (
              <Link href={href} className="font-medium text-[var(--color-primary)] hover:underline">
                {sourceCellLabel(c.key, text)}
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
      if (reportKey === "payroll-checks" || reportKey === "transactions") {
        const text = (value: ReportCell) => typeof value === "string" ? value : null;
        const transactionsReport = reportKey === "transactions";
        const exact = computeGridTotals(filtered.map((row) => ({
          id: text(row.transactionId) ?? "",
          gross: text(row[transactionsReport ? "funderBilled" : "gross"]),
          internalAmount: text(row[transactionsReport ? "employeeBase" : "internalAmount"]),
          agencyAdditional: text(row[transactionsReport ? "agencySpread" : "agencyAdditional"]),
          hours: text(row.hours),
          totalNetPay: text(row.totalNetPay),
          payTo: text(row.payTo),
          checkNumber: text(row.checkNumber),
          checkDate: text(row.checkDate),
          periodBegin: text(row.periodBegin),
          periodEnd: text(row.periodEnd),
          individualId: text(row.individualId),
          individual: text(row[transactionsReport ? "individualName" : "individual"]),
          employeeId: text(row.employeeId),
          employee: text(row[transactionsReport ? "employeeName" : "employee"]),
        })));
        return {
          tiles: [
            { key: "funderBilled", header: "Funder billed", label: formatMoney(exact.gross) },
            { key: "employeeBase", header: "Employee base", label: formatMoney(exact.internal) },
            { key: "agencySpread", header: "Agency spread", label: formatMoney(exact.agencyAdditional) },
            ...(!transactionsReport ? [{
              key: "checkNet",
              header: "Deduplicated source net",
              label: formatMoney(exact.netPerCheck),
            }] : []),
            { key: "hours", header: "Hours", label: formatHours(exact.hours) },
            ...(!transactionsReport ? [{
              key: "checks",
              header: "Checks",
              label: exact.checks.toLocaleString(),
            }] : []),
            { key: "individuals", header: "Individuals", label: exact.individuals.toLocaleString() },
            { key: "employees", header: "Employees", label: exact.employees.toLocaleString() },
            ...(exact.moneyExcludedRows > 0 ? [{
              key: "moneyExcludedRows",
              header: "Excluded money rows",
              label: exact.moneyExcludedRows.toLocaleString(),
            }] : []),
          ],
          rowCount: filtered.length,
          source: totalsSource(filtered, reportKey, table.source),
        };
      }
      const tiles = table.columns
        // Money and hours are additive. Generic integer and percentage columns
        // are not: summing days-left, rates, or percentages creates a confident
        // looking number with no business meaning.
        .filter((c) => (c.type === "money" && c.key !== "checkNet") || c.type === "hours")
        .flatMap((c) => {
          let sum = dec(0);
          let hasValue = false;
          for (const r of filtered) {
            const v = r[c.key];
            if (v === null || v === undefined || v === "") continue;
            try {
              sum = sum.plus(dec(v));
              hasValue = true;
            } catch {
              /* skip an unparseable cell, exactly as before */
            }
          }
          if (!hasValue) return [];
          const label =
            c.type === "money"
              ? formatMoney(sum.toFixed(2))
              : c.type === "hours"
                ? formatHours(sum.toFixed(2))
                : sum.toDecimalPlaces(0).toNumber().toLocaleString();
          return [{ key: c.key, header: c.header, label }];
        });
      return { tiles, rowCount: filtered.length, source: totalsSource(filtered, reportKey, table.source) };
    },
    serializeHidden: true,
  });

  const tileCls = "min-w-0 px-4 py-3";
  const totals = grid.totals;

  return (
    <div className="space-y-3">
      {table.title ? (
        <h2 className="display text-[0.95rem] font-semibold text-[var(--color-ink)]">{table.title}</h2>
      ) : null}

      {table.note ? (
        <p className="border-l-2 border-[var(--color-primary)] pl-3 text-xs leading-5 text-[var(--color-ink-soft)]">
          {table.note}
        </p>
      ) : null}

      <Toolbar
        grid={grid}
        searchPlaceholder="Search this report…"
        exportEndpoint={`/api/grid/export?report=${encodeURIComponent(reportKey)}`}
        exportTitle={table.title ?? "Report"}
        exportFilename={reportKey}
        showColumnChooser
      />

      <FilterBar grid={grid} />

      {/* filtered totals */}
      {totals ? (
        <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)] sm:grid-cols-3 lg:grid-cols-5">
          {totals.tiles.map((t) => {
            const content = (
              <>
                <div className="eyebrow text-[var(--color-ink-faint)]">{t.header}</div>
                <div className="tnum text-lg font-semibold">{t.label}</div>
                {totals.source ? <div className="mt-1 text-[11px] font-medium text-[var(--color-primary)]">{totals.source.label}</div> : null}
              </>
            );
            return totals.source ? (
              <Link key={t.key} href={totals.source.href} className={`${tileCls} hover:bg-black/[0.03]`}>
                {content}
              </Link>
            ) : <div key={t.key} className={tileCls}>{content}</div>;
          })}
          {totals.source ? (
            <Link href={totals.source.href} className={`${tileCls} hover:bg-black/[0.03]`}>
              <div className="eyebrow text-[var(--color-ink-faint)]">Rows</div>
              <div className="tnum text-lg font-semibold">{totals.rowCount.toLocaleString()}</div>
              <div className="mt-1 text-[11px] font-medium text-[var(--color-primary)]">{totals.source.label}</div>
            </Link>
          ) : (
            <div className={tileCls}>
              <div className="eyebrow text-[var(--color-ink-faint)]">Rows</div>
              <div className="tnum text-lg font-semibold">{totals.rowCount.toLocaleString()}</div>
            </div>
          )}
        </div>
      ) : null}

      {/* grid */}
      <div id={`report-table-${table.key}`} className="scroll-thin max-h-[62vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]">
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
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        className="flex flex-1 items-center gap-1 truncate text-left hover:underline"
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
                      <HeaderFilter grid={grid} col={col} />
                    </div>
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
