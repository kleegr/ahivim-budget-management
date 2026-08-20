"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatMoney, formatHours } from "@/lib/money";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import { computeGridTotals, type GridTotals } from "@/lib/business/transaction-totals";
import { useGrid } from "@/components/data-grid/use-grid";
import { Toolbar } from "@/components/data-grid/toolbar";
import { FilterBar, HeaderFilter } from "@/components/data-grid/filter-bar";
import SortMenu from "@/components/data-grid/sort-menu";
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
  { key: "internalAmount", label: "Employee amount", kind: "money", width: 150, accessor: (r) => r.internalAmount },
  { key: "agencyAdditional", label: "Agency difference", kind: "money", width: 160, accessor: (r) => r.agencyAdditional },
  { key: "totalNetPay", label: "Total net pay", kind: "money", width: 120, accessor: (r) => r.totalNetPay },
  { key: "paid", label: "Paid", kind: "text", width: 96, accessor: (r) => (r.isPaid ? "Paid" : "Unpaid") },
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
  canSeeMoney = true,
  initialFilters,
  contextLabel,
}: {
  rows: GridTransaction[];
  canManage: boolean;
  canSeeMoney?: boolean;
  initialFilters?: FilterState;
  contextLabel?: string | null;
}) {
  // Hours-only viewers (canSeeMoney === false) never see a dollar figure, so every
  // money column is removed from the grid entirely — it can't be re-enabled from the
  // column chooser or leak into an export, since it isn't in the column set at all.
  const columns = useMemo(
    () => (canSeeMoney ? COLUMNS : COLUMNS.filter((c) => c.kind !== "money")),
    [canSeeMoney],
  );

  // Reveal any column that arrives pre-filtered (e.g. a budget drill-through seeds
  // the service-period window), so the user can see exactly what is constraining the view.
  const seededKeys = initialFilters ? Object.keys(initialFilters) : [];
  const initialHidden = INITIAL_HIDDEN.filter((k) => !seededKeys.includes(k));

  const grid = useGrid<GridTransaction, GridTotals>({
    rows,
    columns,
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
  const router = useRouter();

  const [selected, setSelected] = useState<GridTransaction | null>(null);
  const [showMore, setShowMore] = useState(false);

  // Row selection (checkboxes) — powers both "sum of what I selected" and the
  // bulk "mark paid". A Set of row ids, independent of the filter.
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const toggleRow = useCallback((id: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Select-all acts on the CURRENT filter (so "filter to these, then select all"
  // is one gesture) — the Google-Sheets "select what I'm looking at".
  const filteredIds = useMemo(() => grid.filtered.map((r) => (r as GridTransaction).id), [grid.filtered]);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => sel.has(id));
  const someFilteredSelected = filteredIds.some((id) => sel.has(id));
  const toggleAllFiltered = useCallback(() => {
    setSel((prev) => {
      const next = new Set(prev);
      const all = filteredIds.every((id) => next.has(id));
      if (all) filteredIds.forEach((id) => next.delete(id));
      else filteredIds.forEach((id) => next.add(id));
      return next;
    });
  }, [filteredIds]);

  // Persist a paid change (one row or the whole selection), then refresh so the
  // filter, sort and totals all reflect the new state consistently.
  const setPaid = useCallback(
    async (ids: string[], paid: boolean) => {
      if (ids.length === 0) return;
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch("/api/transactions/paid", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids, paid }),
        });
        const j = await res.json();
        if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not update.");
        router.refresh();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "Could not update.");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const selectedRows = useMemo(() => (grid.filtered as GridTransaction[]).filter((r) => sel.has(r.id)), [grid.filtered, sel]);
  const selTotals = useMemo(() => (selectedRows.length > 0 ? computeGridTotals(selectedRows) : null), [selectedRows]);
  const SEL_W = 40;

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
    let left = SEL_W; // the selection checkbox column sits sticky at the far left
    for (const c of visibleColumns) {
      if (!c.frozen) break;
      map[c.key] = left;
      left += colWidth(widths, c);
    }
    return map;
  }, [visibleColumns, widths, SEL_W]);

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
  const tableWidth = SEL_W + visibleColumns.reduce((s, c) => s + colWidth(widths, c), 0);

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
            {canSeeMoney ? (
              <>
                <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Agency total (billed)</div><div className="text-xl font-semibold tabular-nums">{formatMoney(totals.gross)}</div></div>
                <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Employee / internal</div><div className="text-xl font-semibold tabular-nums">{formatMoney(totals.internal)}</div></div>
                <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Agency difference</div><div className="text-xl font-semibold tabular-nums">{formatMoney(totals.agencyAdditional)}</div></div>
              </>
            ) : null}
            <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Hours</div><div className="text-xl font-semibold tabular-nums">{formatHours(totals.hours)}</div></div>
            {!canSeeMoney ? (
              <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]"># Transactions</div><div className="text-xl font-semibold tabular-nums">{totals.transactions.toLocaleString()}</div></div>
            ) : null}
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
              {canSeeMoney ? (
                <div className={tileCls}><div className="eyebrow text-[var(--color-text-soft)]">Net pay (per check)</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.netPerCheck)}</div></div>
              ) : null}
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
            <col style={{ width: SEL_W }} />
            {visibleColumns.map((c) => (
              <col key={c.key} style={{ width: colWidth(widths, c) }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-20">
            <tr>
              <th
                className="border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-0 text-center align-middle"
                style={{ position: "sticky", left: 0, zIndex: 30 }}
              >
                <input
                  type="checkbox"
                  aria-label="Select all rows in the current filter"
                  title="Select everything in the current filter"
                  checked={allFilteredSelected}
                  ref={(el) => { if (el) el.indeterminate = !allFilteredSelected && someFilteredSelected; }}
                  onChange={toggleAllFiltered}
                />
              </th>
              {visibleColumns.map((c) => {
                const sortIdx = grid.sort.findIndex((s) => s.key === c.key);
                const s = grid.sort[sortIdx];
                const isFrozen = c.key in frozenLeft;
                const numeric = isNumericKind(c.kind);
                return (
                  <th
                    key={c.key}
                    aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : "none"}
                    className="relative border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 text-left align-middle font-semibold"
                    style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 30 } : undefined}
                  >
                    <div className="flex items-center gap-1">
                      <span className="flex-1 whitespace-normal break-words leading-tight">{c.label}</span>
                      {c.sortable === false ? null : (
                        <SortMenu
                          label={c.label}
                          numeric={numeric}
                          dir={s ? s.dir : null}
                          onSort={(dir) => grid.sortColumn(c.key, dir)}
                        />
                      )}
                      <HeaderFilter grid={grid} col={c} />
                    </div>
                    <span
                      onMouseDown={(e) => {
                        e.preventDefault();
                        dragRef.current = { key: c.key, startX: e.clientX, startW: colWidth(widths, c) };
                      }}
                      title="Drag to resize this column"
                      className="absolute right-0 top-0 h-full w-2 cursor-col-resize select-none border-r-2 border-transparent hover:border-[var(--color-primary)]"
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {topPad > 0 && (
              <tr style={{ height: topPad }}>
                <td colSpan={visibleColumns.length + 1} />
              </tr>
            )}
            {windowed.map((r) => {
              const isSel = sel.has(r.id);
              const rowBg = selected?.id === r.id ? "var(--color-primary-soft,#eef2ff)" : isSel ? "var(--color-primary-tint,#f5f7ff)" : "white";
              return (
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
                className={`cursor-pointer ${selected?.id === r.id ? "bg-[var(--color-primary-soft,#eef2ff)]" : isSel ? "bg-[var(--color-primary-tint,#f5f7ff)]" : "hover:bg-black/[0.03]"}`}
                style={{ height: ROW_H }}
              >
                <td
                  className="border-b border-r border-[var(--color-rule)] text-center"
                  style={{ position: "sticky", left: 0, zIndex: 10, background: rowBg }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select this transaction${r.individual ? ` for ${r.individual}` : ""}`}
                    checked={isSel}
                    onChange={() => toggleRow(r.id)}
                  />
                </td>
                {visibleColumns.map((c) => {
                  const isFrozen = c.key in frozenLeft;
                  const numeric = isNumericKind(c.kind);
                  if (c.key === "paid") {
                    return (
                      <td
                        key={c.key}
                        className="border-b border-r border-[var(--color-rule)] px-2 text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {grid.canManage ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setPaid([r.id], !r.isPaid)}
                            title={r.isPaid ? `Paid${r.paidAt ? ` on ${r.paidAt}` : ""} — click to mark unpaid` : "Mark this transaction paid"}
                            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                              r.isPaid
                                ? "bg-[var(--color-success-soft,#e6f4ea)] text-[var(--color-success,#127a3d)]"
                                : "text-[var(--color-ink-faint)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-ink)]"
                            }`}
                          >
                            {r.isPaid ? "✓ Paid" : "Mark paid"}
                          </button>
                        ) : r.isPaid ? (
                          <span className="text-xs font-medium text-[var(--color-success,#127a3d)]">✓ Paid</span>
                        ) : (
                          <span className="text-[var(--color-ink-faint)]">—</span>
                        )}
                      </td>
                    );
                  }
                  const text = formatCell(c, r);
                  return (
                    <td
                      key={c.key}
                      className={`overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-[var(--color-rule)] px-2 ${numeric ? "text-right tabular-nums" : "text-left"}`}
                      style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 10, background: rowBg } : undefined}
                    >
                      {c.render ? c.render(r, text, { editing: false, canManage: grid.canManage }) : text}
                    </td>
                  );
                })}
              </tr>
              );
            })}
            {bottomPad > 0 && (
              <tr style={{ height: bottomPad }}>
                <td colSpan={visibleColumns.length + 1} />
              </tr>
            )}
            {total === 0 && (
              <tr>
                <td colSpan={visibleColumns.length + 1} className="px-3 py-10 text-center text-[var(--color-text-soft)]">
                  No transactions match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {notice ? (
        <p className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft,#fdecec)] px-3 py-2 text-sm text-[var(--color-danger)]">{notice}</p>
      ) : null}

      {/* Selection status bar — like Google Sheets: totals of exactly what you
          ticked (not the filter), plus bulk "mark paid" on the selection. */}
      {selTotals ? (
        <div className="sticky bottom-0 z-30 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-[var(--color-primary)] bg-[var(--color-primary-tint)] px-3 py-2 text-sm shadow-sm">
          <span className="font-semibold text-[var(--color-ink)]">{selectedRows.length.toLocaleString()} selected</span>
          {canSeeMoney ? (
            <>
              <span className="text-[var(--color-ink-soft)]">Agency <span className="tnum font-semibold text-[var(--color-ink)]">{formatMoney(selTotals.gross)}</span></span>
              <span className="text-[var(--color-ink-soft)]">Employee <span className="tnum font-semibold text-[var(--color-ink)]">{formatMoney(selTotals.internal)}</span></span>
              <span className="text-[var(--color-ink-soft)]">Difference <span className="tnum font-semibold text-[var(--color-ink)]">{formatMoney(selTotals.agencyAdditional)}</span></span>
            </>
          ) : null}
          <span className="text-[var(--color-ink-soft)]">Hours <span className="tnum font-semibold text-[var(--color-ink)]">{formatHours(selTotals.hours)}</span></span>
          {canSeeMoney ? (
            <span className="text-[var(--color-ink-soft)]">Net <span className="tnum font-semibold text-[var(--color-ink)]">{formatMoney(selTotals.netPerCheck)}</span></span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {grid.canManage ? (
              <>
                <button type="button" disabled={busy} onClick={() => setPaid(selectedRows.map((r) => r.id), true)} className="btn btn-sm btn-primary">
                  {busy ? "…" : "Mark paid"}
                </button>
                <button type="button" disabled={busy} onClick={() => setPaid(selectedRows.map((r) => r.id), false)} className="btn btn-sm btn-secondary">
                  Mark unpaid
                </button>
              </>
            ) : null}
            <button type="button" onClick={() => setSel(new Set())} className="text-xs text-[var(--color-ink-soft)] hover:underline">Clear</button>
          </div>
        </div>
      ) : null}

      {selected && (
        <DetailDrawer
          row={selected}
          canSeeMoney={canSeeMoney}
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
  canSeeMoney = true,
  onClose,
  onFilterCheck,
}: {
  row: GridTransaction;
  canSeeMoney?: boolean;
  onClose: () => void;
  onFilterCheck: (checkNumber: string) => void;
}) {
  const line = (label: string, value: ReactNode) => (
    <div className="flex justify-between gap-4 py-1"><span className="text-[var(--color-text-soft)]">{label}</span><span className="text-right font-medium">{value}</span></div>
  );
  return (
    <div className="drawer-in fixed inset-y-0 right-0 z-50 w-full max-w-sm overflow-auto border-l border-[var(--color-rule-strong)] bg-white shadow-2xl">
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
        {canSeeMoney ? line("Rate", row.rate ? formatMoney(row.rate) : "—") : null}
        {canSeeMoney ? line("Agency total", row.gross ? formatMoney(row.gross) : "—") : null}
        {canSeeMoney ? line("Employee amount", row.internalAmount ? formatMoney(row.internalAmount) : "—") : null}
        {canSeeMoney ? line("Agency difference", row.agencyAdditional ? formatMoney(row.agencyAdditional) : "—") : null}
        {canSeeMoney ? line("Total net pay", row.totalNetPay ? formatMoney(row.totalNetPay) : "—") : null}
        {line("Paid", row.isPaid ? `Paid${row.paidAt ? ` on ${row.paidAt}` : ""}` : "Not paid")}
        {line("Period", `${row.periodBegin ?? "—"} → ${row.periodEnd ?? "—"}`)}
        {line("Paid to", RECIPIENT_LABEL[row.paymentRecipient ?? ""] ?? row.paymentRecipient ?? "—")}
        {line("Match status", row.matchStatus ?? "—")}
        {line("Group", row.isGroup ? "Group service" : "Individual")}

        <div className="mt-4 space-y-1.5 border-t border-[var(--color-rule)] pt-3">
          <div className="eyebrow text-[var(--color-text-soft)]">Open</div>
          {row.individualId && <Link href={`/individuals/${row.individualId}`} className="block text-[var(--color-primary)] hover:underline">Individual profile →</Link>}
          {row.employeeId && <Link href={`/employees/${row.employeeId}`} className="block text-[var(--color-primary)] hover:underline">Employee: {row.employee} →</Link>}
          {canSeeMoney && row.individualId && <Link href={`/calculations?individualId=${row.individualId}`} className="block text-[var(--color-primary)] hover:underline">Financial plan →</Link>}
          {row.checkNumber && <button type="button" onClick={() => onFilterCheck(row.checkNumber as string)} className="block text-left text-[var(--color-primary)] hover:underline">Show all rows on check {row.checkNumber} →</button>}
          {row.sourceFileId && <Link href={`/imports/${row.sourceFileId}`} className="block text-[var(--color-primary)] hover:underline">Import batch →</Link>}
          {row.serviceSessionId && <Link href={`/reconciliation`} className="block text-[var(--color-primary)] hover:underline">Reconciliation record →</Link>}
        </div>
      </div>
    </div>
  );
}
