"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { formatMoney, formatHours } from "@/lib/money";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import { computeGridTotals, type GridTotals } from "@/lib/business/transaction-totals";
import { useGrid } from "@/components/data-grid/use-grid";
import { Toolbar } from "@/components/data-grid/toolbar";
import { FilterBar } from "@/components/data-grid/filter-bar";
import { formatCell } from "@/components/data-grid/engine";
import { isNumericKind, type ColumnDef, type FilterState } from "@/components/data-grid/types";
import PeriodControl, { type PeriodRange } from "@/components/period-control";

/* ------------------------------------------------------------------ config */

const ROW_H = 33;
const SEARCH_KEYS = ["individual", "employee", "program", "payTo", "checkNumber"];
const RECIPIENT_LABEL: Record<string, string> = {
  employee: "Paid to employee",
  excellent_staffing: "Payable by agency",
  unknown: "Unknown",
};

/* -------------------------------------------------------------- columns

   The old local ColumnDef is now the shared ColumnDef<GridTransaction>:
     get           -> accessor
     header        -> label
     type          -> kind ("badge" carries badgeLabels = RECIPIENT_LABEL)
     defaultVisible:false -> hidden:true
   frozen / width are unchanged. Only the individual/employee cells need a
   custom render (the profile links); every other cell uses the engine's
   formatCell, so money/hours/date/badge formatting stays identical. */

const COLUMNS: ColumnDef<GridTransaction>[] = [
  { key: "checkDate", label: "Check date", kind: "date", width: 110, frozen: true, accessor: (r) => r.checkDate },
  {
    key: "individual",
    label: "Individual",
    kind: "text",
    width: 170,
    frozen: true,
    accessor: (r) => r.individual,
    render: (r, text) =>
      r.individualId ? (
        <Link href={`/individuals/${r.individualId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
          {text}
        </Link>
      ) : (
        text
      ),
  },
  {
    key: "employee",
    label: "Employee",
    kind: "text",
    width: 170,
    accessor: (r) => r.employee,
    render: (r, text) =>
      r.employeeId ? (
        <Link href={`/employees/${r.employeeId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
          {text}
        </Link>
      ) : (
        text
      ),
  },
  { key: "program", label: "Program", kind: "text", width: 150, accessor: (r) => r.program },
  { key: "payTo", label: "Pay to", kind: "text", width: 150, accessor: (r) => r.payTo },
  { key: "checkNumber", label: "Check #", kind: "text", width: 90, accessor: (r) => r.checkNumber },
  { key: "hours", label: "Hours", kind: "hours", width: 80, accessor: (r) => r.hours },
  { key: "rate", label: "Rate", kind: "money", width: 80, hidden: true, accessor: (r) => r.rate },
  { key: "gross", label: "Agency total", kind: "money", width: 120, accessor: (r) => r.gross },
  { key: "internalAmount", label: "Employee amount", kind: "money", width: 130, accessor: (r) => r.internalAmount },
  { key: "agencyAdditional", label: "Agency markup", kind: "money", width: 140, accessor: (r) => r.agencyAdditional },
  { key: "totalNetPay", label: "Total net pay", kind: "money", width: 120, accessor: (r) => r.totalNetPay },
  { key: "periodBegin", label: "Period begin", kind: "date", width: 110, hidden: true, accessor: (r) => r.periodBegin },
  { key: "periodEnd", label: "Period end", kind: "date", width: 110, hidden: true, accessor: (r) => r.periodEnd },
  { key: "paymentRecipient", label: "Paid to", kind: "badge", width: 150, hidden: true, badgeLabels: RECIPIENT_LABEL, accessor: (r) => r.paymentRecipient },
  { key: "matchStatus", label: "Match status", kind: "badge", width: 120, hidden: true, badgeLabels: RECIPIENT_LABEL, accessor: (r) => r.matchStatus },
  { key: "groupStatus", label: "Group status", kind: "badge", width: 120, hidden: true, badgeLabels: RECIPIENT_LABEL, accessor: (r) => (r.isGroup ? "Group" : "Individual") },
];

// The existing per-column width and default-hidden maps. useGrid seeds its
// width and hidden state from these (it reads initialHidden, not column.hidden),
// so the default-visible set and the resize baseline are preserved exactly.
const INITIAL_WIDTHS: Record<string, number> = Object.fromEntries(
  COLUMNS.map((c) => [c.key, c.width ?? 120] as const),
);
const INITIAL_HIDDEN: string[] = COLUMNS.filter((c) => c.hidden).map((c) => c.key);

const colWidth = (widths: Record<string, number>, c: ColumnDef<GridTransaction>): number =>
  widths[c.key] ?? c.width ?? 120;

/* -------------------------------------------------------------- component */

export default function TransactionsGrid({
  rows,
  canManage,
  initialFilters,
  contextLabel,
}: {
  rows: GridTransaction[];
  canManage: boolean;
  initialFilters?: FilterState;
  contextLabel?: string | null;
}) {
  // Reveal any column that arrives pre-filtered (e.g. a budget drill-through seeds
  // the service-period window), so the user can see exactly what is constraining the view.
  const seededKeys = initialFilters ? Object.keys(initialFilters) : [];
  const initialHidden = INITIAL_HIDDEN.filter((k) => !seededKeys.includes(k));

  const grid = useGrid<GridTransaction, GridTotals>({
    rows,
    columns: COLUMNS,
    gridKey: "transactions",
    canManage,
    initialSort: [{ key: "checkDate", dir: "desc" }],
    initialHidden,
    initialWidths: INITIAL_WIDTHS,
    initialFilters,
    searchKeys: SEARCH_KEYS,
    computeTotals: computeGridTotals,
    serializeHidden: true,
    serializeWidths: true,
  });

  const { visibleColumns, sorted, widths } = grid;

  const [selected, setSelected] = useState<GridTransaction | null>(null);
  const [showMore, setShowMore] = useState(false);

  // The persistent period control drives the check-date filter (and the URL).
  const setFilter = grid.setFilter;
  const applyPeriod = useCallback(
    (r: PeriodRange) => setFilter("checkDate", r ? { from: r.from, to: r.to } : null),
    [setFilter],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(560);

  /* ---- virtualization ---- */
  const total = sorted.length;
  const overscan = 8;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - overscan);
  const visibleCount = Math.ceil(viewportH / ROW_H) + overscan * 2;
  const endIdx = Math.min(total, startIdx + visibleCount);
  const topPad = startIdx * ROW_H;
  const bottomPad = Math.max(0, (total - endIdx) * ROW_H);
  const windowed = sorted.slice(startIdx, endIdx);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight || 560);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // frozen-column left offsets (leading run of visible frozen columns)
  const frozenLeft = useMemo(() => {
    const map: Record<string, number> = {};
    let left = 0;
    for (const c of visibleColumns) {
      if (!c.frozen) break;
      map[c.key] = left;
      left += colWidth(widths, c);
    }
    return map;
  }, [visibleColumns, widths]);

  // column resize drag → grid.setWidth (min 56px)
  const setWidth = grid.setWidth;
  const dragRef = useRef<{ key: string; startX: number; startW: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const w = Math.max(56, d.startW + (e.clientX - d.startX));
      setWidth(d.key, w);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setWidth]);

  /* ---------------------------------------------------------------- render */

  const tileCls = "rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2";
  const totals = grid.totals;
  const tableWidth = visibleColumns.reduce((s, c) => s + colWidth(widths, c), 0);

  return (
    <div className="space-y-3">
      {contextLabel ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-primary)] bg-[var(--color-primary-tint)] px-3 py-2 text-sm">
          <span className="text-[var(--color-ink)]">
            Showing rows for <span className="font-semibold">{contextLabel}</span>. The totals below are exactly these rows.
          </span>
          <Link href="/transactions" className="font-medium text-[var(--color-primary)] hover:underline">
            Show all transactions →
          </Link>
        </div>
      ) : null}
      <PeriodControl onChange={applyPeriod} paramKey="period" />
      <Toolbar
        grid={grid}
        searchPlaceholder="Search transactions…"
        exportEndpoint="/api/transactions/export"
        exportTitle="Transactions"
        exportFilename="transactions"
        showColumnChooser
      />

      <FilterBar grid={grid} />

      {/* Filtered totals: three you read first, the rest a click away. All
          recompute live on the visible filter, matching exactly what you see. */}
      {totals ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Agency total (billed)</div><div className="text-xl font-semibold tabular-nums">{formatMoney(totals.gross)}</div></div>
            <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Employee / internal</div><div className="text-xl font-semibold tabular-nums">{formatMoney(totals.internal)}</div></div>
            <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Agency difference</div><div className="text-xl font-semibold tabular-nums">{formatMoney(totals.agencyAdditional)}</div></div>
            <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Hours</div><div className="text-xl font-semibold tabular-nums">{formatHours(totals.hours)}</div></div>
          </div>
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            className="text-xs font-medium text-[var(--color-primary)] hover:underline"
            aria-expanded={showMore}
          >
            {showMore ? "Hide extra totals" : "More totals"}
          </button>
          {showMore ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Net pay (per check)</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.netPerCheck)}</div></div>
              <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]"># Transactions</div><div className="text-lg font-semibold tabular-nums">{totals.transactions.toLocaleString()}</div></div>
              <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]"># Checks</div><div className="text-lg font-semibold tabular-nums">{totals.checks.toLocaleString()}</div></div>
              <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]"># Individuals</div><div className="text-lg font-semibold tabular-nums">{totals.individuals.toLocaleString()}</div></div>
              <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]"># Employees</div><div className="text-lg font-semibold tabular-nums">{totals.employees.toLocaleString()}</div></div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* grid */}
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        className="relative max-h-[62vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]"
      >
        <table className="border-collapse text-sm" style={{ tableLayout: "fixed", width: tableWidth }}>
          <colgroup>
            {visibleColumns.map((c) => (
              <col key={c.key} style={{ width: colWidth(widths, c) }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-20">
            <tr>
              {visibleColumns.map((c) => {
                const sortIdx = grid.sort.findIndex((s) => s.key === c.key);
                const s = grid.sort[sortIdx];
                const isFrozen = c.key in frozenLeft;
                return (
                  <th
                    key={c.key}
                    aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : "none"}
                    className="relative border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 text-left align-bottom font-semibold"
                    style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 30 } : undefined}
                  >
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        className="flex-1 truncate text-left hover:underline"
                        title="Click to sort, Shift-click to add a sort level"
                        onClick={(e) => grid.toggleSort(c.key, e.shiftKey)}
                      >
                        {c.label}
                        {s && (
                          <span className="ml-1 text-[10px] text-[var(--color-primary)]">
                            {s.dir === "asc" ? "▲" : "▼"}
                            {grid.sort.length > 1 ? sortIdx + 1 : ""}
                          </span>
                        )}
                      </button>
                    </div>
                    <span
                      onMouseDown={(e) => {
                        e.preventDefault();
                        dragRef.current = { key: c.key, startX: e.clientX, startW: colWidth(widths, c) };
                      }}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none hover:bg-[var(--color-primary)]"
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {topPad > 0 && (
              <tr style={{ height: topPad }}>
                <td colSpan={visibleColumns.length} />
              </tr>
            )}
            {windowed.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelected(r)}
                onKeyDown={(e) => {
                  // Only when the row itself is focused, so nested links keep their own Enter/Space.
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    setSelected(r);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label={`View transaction details${r.individual ? ` for ${r.individual}` : ""}${r.checkDate ? ` on ${r.checkDate}` : ""}`}
                className={`cursor-pointer ${selected?.id === r.id ? "bg-[var(--color-primary-soft,#eef2ff)]" : "hover:bg-black/[0.03]"}`}
                style={{ height: ROW_H }}
              >
                {visibleColumns.map((c) => {
                  const isFrozen = c.key in frozenLeft;
                  const numeric = isNumericKind(c.kind);
                  const text = formatCell(c, r);
                  return (
                    <td
                      key={c.key}
                      className={`overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-[var(--color-rule)] px-2 ${numeric ? "text-right tabular-nums" : "text-left"}`}
                      style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 10, background: selected?.id === r.id ? "var(--color-primary-soft,#eef2ff)" : "white" } : undefined}
                    >
                      {c.render ? c.render(r, text, { editing: false, canManage: grid.canManage }) : text}
                    </td>
                  );
                })}
              </tr>
            ))}
            {bottomPad > 0 && (
              <tr style={{ height: bottomPad }}>
                <td colSpan={visibleColumns.length} />
              </tr>
            )}
            {total === 0 && (
              <tr>
                <td colSpan={visibleColumns.length} className="px-3 py-10 text-center text-[var(--color-text-soft)]">
                  No transactions match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <DetailDrawer
          row={selected}
          onClose={() => setSelected(null)}
          onFilterCheck={(cn) => {
            grid.setFilter("checkNumber", { selected: [cn], contains: "" });
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- drawer */

function DetailDrawer({
  row,
  onClose,
  onFilterCheck,
}: {
  row: GridTransaction;
  onClose: () => void;
  onFilterCheck: (checkNumber: string) => void;
}) {
  const line = (label: string, value: ReactNode) => (
    <div className="flex justify-between gap-4 py-1"><span className="text-[var(--color-text-soft)]">{label}</span><span className="text-right font-medium">{value}</span></div>
  );
  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full max-w-sm overflow-auto border-l border-[var(--color-rule-strong)] bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-[var(--color-rule)] px-4 py-3">
        <div>
          <div className="eyebrow text-[var(--color-text-soft)]">Transaction</div>
          <div className="text-lg font-semibold">{row.individual ?? "—"}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 text-lg hover:bg-black/5" aria-label="Close">×</button>
      </div>
      <div className="px-4 py-3 text-sm">
        {line("Check date", row.checkDate ?? "—")}
        {line("Check #", row.checkNumber ?? "—")}
        {line("Program", row.program ?? "—")}
        {line("Pay to", row.payTo ?? "—")}
        {line("Hours", row.hours ? formatHours(row.hours) : "—")}
        {line("Rate", row.rate ? formatMoney(row.rate) : "—")}
        {line("Agency total", row.gross ? formatMoney(row.gross) : "—")}
        {line("Employee amount", row.internalAmount ? formatMoney(row.internalAmount) : "—")}
        {line("Agency markup", row.agencyAdditional ? formatMoney(row.agencyAdditional) : "—")}
        {line("Total net pay", row.totalNetPay ? formatMoney(row.totalNetPay) : "—")}
        {line("Period", `${row.periodBegin ?? "—"} → ${row.periodEnd ?? "—"}`)}
        {line("Paid to", RECIPIENT_LABEL[row.paymentRecipient ?? ""] ?? row.paymentRecipient ?? "—")}
        {line("Match status", row.matchStatus ?? "—")}
        {line("Group", row.isGroup ? "Group service" : "Individual")}

        <div className="mt-4 space-y-1.5 border-t border-[var(--color-rule)] pt-3">
          <div className="eyebrow text-[var(--color-text-soft)]">Open</div>
          {row.individualId && <Link href={`/individuals/${row.individualId}`} className="block text-[var(--color-primary)] hover:underline">Individual profile →</Link>}
          {row.employeeId && <Link href={`/employees/${row.employeeId}`} className="block text-[var(--color-primary)] hover:underline">Employee: {row.employee} →</Link>}
          {row.individualId && <Link href={`/calculations?individualId=${row.individualId}`} className="block text-[var(--color-primary)] hover:underline">Projections / budget plan →</Link>}
          {row.checkNumber && <button type="button" onClick={() => onFilterCheck(row.checkNumber as string)} className="block text-left text-[var(--color-primary)] hover:underline">Show all rows on check {row.checkNumber} →</button>}
          {row.sourceFileId && <Link href={`/imports/${row.sourceFileId}`} className="block text-[var(--color-primary)] hover:underline">Import batch →</Link>}
          {row.serviceSessionId && <Link href={`/reconciliation`} className="block text-[var(--color-primary)] hover:underline">Reconciliation record →</Link>}
        </div>
      </div>
    </div>
  );
}
