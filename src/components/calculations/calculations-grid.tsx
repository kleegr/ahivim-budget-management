"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { dec, formatMoney, formatHours } from "@/lib/money";
import type { StrategyGridRow, ProgramRate } from "@/lib/manage/calculation-strategies";
import { type ColumnDef, type GridFieldKind, isNumericKind } from "@/components/data-grid/types";
import { formatCell, rawValue } from "@/components/data-grid/engine";
import { useGrid } from "@/components/data-grid/use-grid";
import { Toolbar } from "@/components/data-grid/toolbar";
import { FilterBar } from "@/components/data-grid/filter-bar";

/**
 * The Calculations workspace on top of the shared data-grid engine. The engine
 * owns filtering, sorting, search, saved views and export; the Toolbar and
 * FilterBar own their UI. Everything that makes this grid special — inline cell
 * editing, Excel-style multi-cell selection + copy/paste, the Explain drawer,
 * the analytics-columns toggle and the add/duplicate/archive actions — still
 * lives here, and only points at `grid.sorted` / `grid.visibleColumns`.
 */

/* ------------------------------------------------------------------ types */

interface CalcTotals {
  yearly: string;
  monthly: string;
  net: string;
  after: string;
  strategies: number;
  individuals: number;
}

interface ExplainStep {
  key: string;
  label: string;
  formula: string;
  value: string;
}
interface ExplainResult {
  yearlyGross: string;
  monthlyGross: string;
  grossNet: string;
  net: string;
  afterAll: string | null;
  lineGross: { programLabel: string; programId?: string; hours: string; rate: string; gross: string; isOverride: boolean; defaultRate: string }[];
  steps: ExplainStep[];
}
interface Revision {
  id: string;
  revision: number;
  reason: string | null;
  createdAt: string;
}

/* ------------------------------------------------------- percent display */

function pctDisplay(fraction: string | null): string {
  if (!fraction) return "";
  const d = dec(fraction).times(100);
  return d.toDecimalPlaces(2).toString();
}

function pct100(frac: string | null | undefined): string | null {
  if (frac === null || frac === undefined || frac === "") return null;
  try {
    return dec(frac).times(100).toDecimalPlaces(0).toString();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- component */

export default function CalculationsGrid({
  rows,
  programs,
  individuals,
  canManage,
}: {
  rows: StrategyGridRow[];
  programs: ProgramRate[];
  individuals: { id: string; name: string }[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [editing, setEditing] = useState<{ rowId: string; colKey: string } | null>(null);
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  const [selEnd, setSelEnd] = useState<{ row: number; col: number } | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [addFor, setAddFor] = useState("");

  /* ---- edit commit (PATCH /api/calculation-strategies/[id] with col.patch) ---- */
  const commitEdit = useCallback(
    async (col: ColumnDef<StrategyGridRow>, r: StrategyGridRow, value: string) => {
      if (!col.patch) return;
      const current = rawValue(col, r);
      if (value === current) {
        setEditing(null);
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch(`/api/calculation-strategies/${r.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(col.patch(value)),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save.");
        router.refresh();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "Could not save the change.");
      } finally {
        setBusy(false);
        setEditing(null);
      }
    },
    [router],
  );

  /* ---- columns: same shape as before, now ColumnDef<StrategyGridRow>[] ---- */
  const columns = useMemo<ColumnDef<StrategyGridRow>[]>(() => {
    // Editable cell: an <EditCell> when the cell is being edited, else the value
    // (or an em-dash affordance for managers). Reuses the existing commit path.
    const editable = (c: Omit<ColumnDef<StrategyGridRow>, "render" | "editable">): ColumnDef<StrategyGridRow> => {
      const col: ColumnDef<StrategyGridRow> = { ...c, editable: true };
      col.render = (row, text, ctx) =>
        ctx.editing ? (
          <EditCell
            kind={col.kind}
            initial={rawValue(col, row)}
            onCommit={(v) => commitEdit(col, row, v)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <span className={col.accessor(row) ? "" : "text-[var(--color-text-soft)]"}>{text || (ctx.canManage ? "—" : "")}</span>
        );
      return col;
    };

    const base: ColumnDef<StrategyGridRow>[] = [
      {
        key: "individual",
        label: "Individual",
        kind: "text",
        frozen: true,
        accessor: (r) => r.individualName,
        render: (row) => (
          <Link
            href={`/individuals/${row.individualId}`}
            className="group inline-flex items-center gap-1 font-medium text-[var(--color-primary)] hover:underline"
            onClick={(e) => e.stopPropagation()}
            title={`Open ${row.individualName}`}
          >
            {row.individualName}
            <span className="opacity-0 transition-opacity group-hover:opacity-100">→</span>
          </Link>
        ),
      },
      editable({ key: "label", label: "Line", kind: "text", accessor: (r) => r.label, patch: (v) => ({ label: v }) }),
      editable({ key: "renewalDate", label: "Renewal date", kind: "date", frozen: true, accessor: (r) => r.renewalDate, patch: (v) => ({ renewalDate: v || null }) }),
      editable({ key: "cut1Percent", label: "1st cut %", kind: "percent", exportType: "text", accessor: (r) => pctDisplay(r.cut1Percent), patch: (v) => ({ cut1Percent: v }) }),
      editable({ key: "cut2Percent", label: "2nd cut %", kind: "percent", exportType: "text", accessor: (r) => pctDisplay(r.cut2Percent), patch: (v) => ({ cut2Percent: v }) }),
      editable({ key: "clockAdjustment", label: "Clock", kind: "money", accessor: (r) => r.clockAdjustment, patch: (v) => ({ clockAdjustment: v }) }),
      editable({ key: "otherAdjustment", label: "Other adj.", kind: "money", accessor: (r) => r.otherAdjustment, patch: (v) => ({ otherAdjustment: v }) }),
    ];

    const programCols: ColumnDef<StrategyGridRow>[] = programs.map((p) =>
      editable({
        key: `prog:${p.id}`,
        label: p.code,
        kind: "hours",
        programId: p.id,
        accessor: (r) => r.hours[p.id] ?? null,
        patch: (v) => ({ hours: { [p.id]: v === "" ? null : v } }),
      }),
    );

    const computed: ColumnDef<StrategyGridRow>[] = [
      { key: "yearlyGross", label: "Yearly gross", kind: "computed", accessor: (r) => r.yearlyGross },
      { key: "monthlyGross", label: "Monthly gross", kind: "computed", accessor: (r) => r.monthlyGross },
      { key: "grossNet", label: "Gross net", kind: "computed", accessor: (r) => r.grossNet },
      { key: "net", label: "Net", kind: "computed", accessor: (r) => r.net },
      editable({ key: "afterAll", label: "After All", kind: "money", accessor: (r) => r.afterAll, patch: (v) => ({ afterAll: v === "" ? null : v }) }),
      editable({ key: "account", label: "Account", kind: "text", accessor: (r) => r.account, patch: (v) => ({ account: v || null }) }),
    ];

    // Optional read-only analysis columns: actual-vs-plan, forecast, and the
    // workbook↔system parity check. Appended when "Show analysis" is on.
    const analytics: ColumnDef<StrategyGridRow>[] = showAnalytics
      ? [
          { key: "a_actualHours", label: "Actual hrs", kind: "hours", accessor: (r) => r.analytics?.actualHours ?? null },
          { key: "a_actualInternal", label: "Actual $", kind: "computed", accessor: (r) => r.analytics?.actualInternal ?? null },
          { key: "a_scheduledHours", label: "Scheduled hrs", kind: "hours", accessor: (r) => r.analytics?.scheduledHours ?? null },
          { key: "a_remainingHours", label: "Remaining hrs", kind: "hours", accessor: (r) => r.analytics?.remainingHours ?? null },
          { key: "a_utilization", label: "Utilization", kind: "percent", exportType: "text", accessor: (r) => pct100(r.analytics?.utilizationPercent) },
          { key: "a_projected", label: "Projected exhaustion", kind: "date", accessor: (r) => r.analytics?.projectedExhaustion ?? null },
          { key: "a_workbook", label: "Workbook (After All)", kind: "computed", accessor: (r) => r.analytics?.workbookValue ?? null },
          { key: "a_system", label: "System (Net)", kind: "computed", accessor: (r) => r.analytics?.systemValue ?? null },
          { key: "a_diff", label: "Δ (wb − sys)", kind: "computed", accessor: (r) => r.analytics?.difference ?? null },
          { key: "a_flags", label: "Flags", kind: "text", accessor: (r) => (r.analytics?.warnings.length ? r.analytics.warnings.join(", ") : null) },
        ]
      : [];

    return [...base, ...programCols, ...computed, ...analytics];
  }, [programs, showAnalytics, commitEdit]);

  const grid = useGrid<StrategyGridRow, CalcTotals>({
    rows,
    columns,
    gridKey: "calculations",
    canManage,
    initialSort: [{ key: "individual", dir: "asc" }],
    searchKeys: ["individual", "label", "account"],
    computeTotals: (filtered) => {
      let yearly = dec(0),
        monthly = dec(0),
        net = dec(0),
        after = dec(0);
      const inds = new Set<string>();
      for (const r of filtered) {
        yearly = yearly.plus(dec(r.yearlyGross || 0));
        monthly = monthly.plus(dec(r.monthlyGross || 0));
        net = net.plus(dec(r.net || 0));
        if (r.afterAll) after = after.plus(dec(r.afterAll));
        inds.add(r.individualId);
      }
      return {
        yearly: yearly.toFixed(2),
        monthly: monthly.toFixed(2),
        net: net.toFixed(2),
        after: after.toFixed(2),
        strategies: filtered.length,
        individuals: inds.size,
      };
    },
    serializeHidden: false,
    serializeWidths: false,
    exportAllColumns: true,
  });

  /* ---- multi-cell selection, copy & paste (Excel-style) ---- */
  const selBounds = useMemo(() => {
    if (!active) return null;
    const end = selEnd ?? active;
    return {
      r0: Math.min(active.row, end.row),
      r1: Math.max(active.row, end.row),
      c0: Math.min(active.col, end.col),
      c1: Math.max(active.col, end.col),
    };
  }, [active, selEnd]);

  const inSelection = (r: number, c: number) =>
    !!selBounds && r >= selBounds.r0 && r <= selBounds.r1 && c >= selBounds.c0 && c <= selBounds.c1;

  const mergePatch = (target: Record<string, unknown>, addition: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(addition)) {
      if (k === "hours" && target.hours) {
        target.hours = { ...(target.hours as Record<string, unknown>), ...(v as Record<string, unknown>) };
      } else {
        target[k] = v;
      }
    }
    return target;
  };

  const saveCells = useCallback(
    async (edits: { rowId: string; body: Record<string, unknown> }[]) => {
      if (edits.length === 0) return;
      setBusy(true);
      setNotice(null);
      try {
        const byRow = new Map<string, Record<string, unknown>>();
        for (const e of edits) byRow.set(e.rowId, mergePatch(byRow.get(e.rowId) ?? {}, e.body));
        for (const [rowId, body] of byRow) {
          const res = await fetch(`/api/calculation-strategies/${rowId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save pasted values.");
        }
        setNotice(`Updated ${byRow.size} row${byRow.size === 1 ? "" : "s"} from paste.`);
        router.refresh();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "Paste failed.");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const copySelection = useCallback(() => {
    if (!selBounds) return;
    const lines: string[] = [];
    for (let r = selBounds.r0; r <= selBounds.r1; r++) {
      const cells: string[] = [];
      for (let c = selBounds.c0; c <= selBounds.c1; c++) {
        const col = grid.visibleColumns[c];
        const row = grid.sorted[r];
        cells.push(col && row ? col.accessor(row) ?? "" : "");
      }
      lines.push(cells.join("\t"));
    }
    navigator.clipboard
      ?.writeText(lines.join("\n"))
      .then(() => setNotice(`Copied ${selBounds.r1 - selBounds.r0 + 1} × ${selBounds.c1 - selBounds.c0 + 1} cells.`))
      .catch(() => {});
  }, [selBounds, grid.sorted, grid.visibleColumns]);

  const pasteBlock = useCallback(
    (text: string) => {
      if (!canManage || !active) return;
      const matrix = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
      const edits: { rowId: string; body: Record<string, unknown> }[] = [];
      let skipped = 0;
      for (let di = 0; di < matrix.length; di++) {
        const row = grid.sorted[active.row + di];
        if (!row) break;
        for (let dj = 0; dj < matrix[di]!.length; dj++) {
          const col = grid.visibleColumns[active.col + dj];
          if (!col) continue;
          if (!col.editable || !col.patch) {
            skipped++;
            continue;
          }
          edits.push({ rowId: row.id, body: col.patch(matrix[di]![dj]!.trim()) as Record<string, unknown> });
        }
      }
      if (edits.length === 0) {
        setNotice(skipped ? "Those cells are read-only — paste onto editable columns." : "Nothing to paste.");
        return;
      }
      saveCells(edits);
    },
    [canManage, active, grid.sorted, grid.visibleColumns, saveCells],
  );

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !active) return;
    const move = (dr: number, dc: number, extend: boolean) => {
      e.preventDefault();
      const nr = Math.min(Math.max(0, active.row + dr), grid.sorted.length - 1);
      const nc = Math.min(Math.max(0, active.col + dc), grid.visibleColumns.length - 1);
      if (extend) setSelEnd({ row: nr, col: nc });
      else {
        setActive({ row: nr, col: nc });
        setSelEnd(null);
      }
    };
    if (e.key === "ArrowDown") move(1, 0, e.shiftKey);
    else if (e.key === "ArrowUp") move(-1, 0, e.shiftKey);
    else if (e.key === "ArrowLeft") move(0, -1, e.shiftKey);
    else if (e.key === "ArrowRight") move(0, 1, e.shiftKey);
    else if (e.key === "Enter" || e.key === "F2") {
      const col = grid.visibleColumns[active.col];
      const row = grid.sorted[active.row];
      if (canManage && col?.editable && row) {
        e.preventDefault();
        setEditing({ rowId: row.id, colKey: col.key });
      }
    } else if (e.key === "Escape") setSelEnd(null);
    else if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      copySelection();
    }
  };

  const addStrategy = async () => {
    if (!addFor) return;
    setBusy(true);
    try {
      const res = await fetch("/api/calculation-strategies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ individualId: addFor }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not add strategy.");
      setAddFor("");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not add strategy.");
    } finally {
      setBusy(false);
    }
  };

  const rowAction = async (id: string, action: "duplicate" | "archive") => {
    setBusy(true);
    try {
      const url = action === "duplicate" ? `/api/calculation-strategies/${id}/duplicate` : `/api/calculation-strategies/${id}/status`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: action === "archive" ? JSON.stringify({ status: "archived" }) : "{}",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Action failed.");
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  // Hardcoded frozen leading column(s): the loop stops at the first non-frozen
  // column, so `individual` is sticky (kept identical to the original grid).
  const frozenLeft = useMemo(() => {
    const map: Record<string, number> = {};
    let left = 0;
    const widths: Record<string, number> = { individual: 170, renewalDate: 130 };
    for (const c of grid.visibleColumns) {
      if (!c.frozen) break;
      map[c.key] = left;
      left += widths[c.key] ?? 140;
    }
    return map;
  }, [grid.visibleColumns]);

  const tile = "rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2";
  const totals = grid.totals;

  return (
    <div className="space-y-3">
      {/* shared toolbar: search, result count, reset, saved views, export + our extras */}
      <Toolbar
        grid={grid}
        searchPlaceholder="Search projections…"
        exportEndpoint="/api/calculations/export"
        exportTitle="Calculations"
        exportFilename="calculations"
        showColumnChooser={false}
        extraActions={
          <>
            <button
              type="button"
              onClick={() => setShowAnalytics((s) => !s)}
              className={`btn btn-sm ${showAnalytics ? "btn-primary" : "btn-secondary"}`}
            >
              {showAnalytics ? "Hide analysis" : "Show analysis"}
            </button>
            {canManage && (
              <span className="ml-auto inline-flex items-center gap-1">
                <select value={addFor} onChange={(e) => setAddFor(e.target.value)} className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1.5">
                  <option value="">Add strategy for…</option>
                  {individuals.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
                <button type="button" onClick={addStrategy} disabled={busy || !addFor} className="btn btn-sm btn-primary disabled:opacity-50">Add</button>
              </span>
            )}
          </>
        }
      />

      {/* visible filter bar (pills + active chips) */}
      <FilterBar grid={grid} />

      {/* filter-aware totals */}
      {totals && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Yearly gross</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.yearly)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Monthly gross</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.monthly)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Net (monthly)</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.net)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">After All</div><div className="text-lg font-semibold tabular-nums">{formatMoney(totals.after)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]"># Strategies</div><div className="text-lg font-semibold tabular-nums">{totals.strategies}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]"># Individuals</div><div className="text-lg font-semibold tabular-nums">{totals.individuals}</div></div>
        </div>
      )}

      {notice && <div className="rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-1.5 text-sm">{notice}</div>}
      {!canManage && <div className="rounded border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-soft)]">You have read-only access. Editing is available to managers.</div>}

      {/* grid */}
      {canManage && (
        <p className="text-xs text-[var(--color-text-soft)]">
          Tip: click a cell to select, drag-select with Shift-click or arrow keys, <kbd className="rounded border border-[var(--color-rule-strong)] px-1">Ctrl/⌘+C</kbd> to copy, and paste a block from Excel with <kbd className="rounded border border-[var(--color-rule-strong)] px-1">Ctrl/⌘+V</kbd>. Double-click or <kbd className="rounded border border-[var(--color-rule-strong)] px-1">Enter</kbd> to edit.
        </p>
      )}
      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        onPaste={(e) => {
          if (!canManage || !active) return;
          e.preventDefault();
          pasteBlock(e.clipboardData.getData("text/plain"));
        }}
        className="scroll-thin relative max-h-[64vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)] outline-none focus:ring-2 focus:ring-[var(--color-primary-soft)]"
      >
        <table className="border-collapse text-sm" style={{ tableLayout: "auto" }}>
          <thead className="sticky top-0 z-20">
            <tr>
              {grid.visibleColumns.map((c) => {
                const sortIdx = grid.sort.findIndex((s) => s.key === c.key);
                const s = grid.sort[sortIdx];
                const isFrozen = c.key in frozenLeft;
                return (
                  <th key={c.key} className="relative whitespace-nowrap border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 text-left align-bottom font-semibold" style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 30, minWidth: c.key === "individual" ? 170 : 130 } : undefined}>
                    <div className="flex items-center gap-1">
                      <button type="button" className="flex-1 truncate text-left hover:underline" title="Sort (Shift-click to add a level)" onClick={(e) => grid.toggleSort(c.key, e.shiftKey)}>
                        {c.label}
                        {s && <span className="ml-1 text-[10px] text-[var(--color-primary)]">{s.dir === "asc" ? "▲" : "▼"}{grid.sort.length > 1 ? sortIdx + 1 : ""}</span>}
                      </button>
                    </div>
                  </th>
                );
              })}
              <th className="border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 text-left font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grid.sorted.map((r, ri) => (
              <tr key={r.id} className="hover:bg-black/[0.02]">
                {grid.visibleColumns.map((c, ci) => {
                  const isFrozen = c.key in frozenLeft;
                  const numeric = isNumericKind(c.kind);
                  const isEditing = editing?.rowId === r.id && editing?.colKey === c.key;
                  const canEdit = canManage && !!c.editable;
                  const isActive = active?.row === ri && active?.col === ci;
                  const selected = inSelection(ri, ci);
                  const frozenBg = isActive ? "var(--color-primary-tint)" : selected ? "var(--color-primary-soft)" : "white";
                  const text = formatCell(c, r);
                  return (
                    <td
                      key={c.key}
                      onClick={(e) => {
                        if (e.shiftKey && active) setSelEnd({ row: ri, col: ci });
                        else {
                          setActive({ row: ri, col: ci });
                          setSelEnd(null);
                        }
                        gridRef.current?.focus();
                      }}
                      onDoubleClick={() => canEdit && setEditing({ rowId: r.id, colKey: c.key })}
                      className={`relative whitespace-nowrap border-b border-r px-2 py-1 ${numeric ? "text-right tabular-nums" : "text-left"} ${canEdit ? "cursor-cell" : "cursor-default"} ${c.kind === "computed" ? "text-[var(--color-text-soft)]" : ""} ${isActive ? "border-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]" : "border-[var(--color-rule)]"} ${selected && !isActive ? "bg-[var(--color-primary-soft)]" : c.kind === "computed" ? "bg-[var(--color-surface-muted)]" : ""}`}
                      style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 10, background: frozenBg, minWidth: c.key === "individual" ? 170 : 130 } : undefined}
                      title={c.key === "renewalDate" && r.periodStart ? `Budget period: ${r.periodStart} → ${r.periodEnd}` : undefined}
                    >
                      {c.render ? (
                        c.render(r, text, { editing: isEditing, canManage })
                      ) : (
                        <span className={c.accessor(r) ? "" : "text-[var(--color-text-soft)]"}>{text || (canEdit ? "—" : "")}</span>
                      )}
                    </td>
                  );
                })}
                <td className="whitespace-nowrap border-b border-[var(--color-rule)] px-2 py-1 text-xs">
                  <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => setDrawerId(r.id)}>Explain</button>
                  {canManage && (
                    <>
                      <span className="px-1 text-[var(--color-text-soft)]">·</span>
                      <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => rowAction(r.id, "duplicate")}>Duplicate</button>
                      <span className="px-1 text-[var(--color-text-soft)]">·</span>
                      <button type="button" className="text-[var(--color-text-soft)] hover:text-red-600 hover:underline" onClick={() => { if (confirm(`Archive ${r.individualName} ${r.label}? It is kept in history, not deleted.`)) rowAction(r.id, "archive"); }}>Archive</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {grid.sorted.length === 0 && (
              <tr>
                <td colSpan={grid.visibleColumns.length + 1} className="px-3 py-10 text-center text-[var(--color-text-soft)]">No strategies match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {drawerId && <ExplainDrawer strategyId={drawerId} row={rows.find((r) => r.id === drawerId)} canManage={canManage} onClose={() => setDrawerId(null)} />}
    </div>
  );
}

/* -------------------------------------------------------------- edit cell */

function EditCell({ kind, initial, onCommit, onCancel }: { kind: GridFieldKind; initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type={kind === "date" ? "date" : kind === "text" ? "text" : "number"}
      step={kind === "hours" || kind === "money" || kind === "percent" ? "any" : undefined}
      defaultValue={initial}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onCommit((e.target as HTMLInputElement).value.trim()); }
        else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      onBlur={(e) => onCommit(e.target.value.trim())}
      className="w-full min-w-[70px] rounded border border-[var(--color-primary)] bg-white px-1 py-0.5 text-right tabular-nums outline-none"
    />
  );
}

/* -------------------------------------------------------------- drawer */

function ExplainDrawer({ strategyId, row, canManage, onClose }: { strategyId: string; row: StrategyGridRow | undefined; canManage: boolean; onClose: () => void }) {
  const router = useRouter();
  const [data, setData] = useState<{ explain: ExplainResult; revisions: Revision[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingRate, setSavingRate] = useState<string | null>(null);

  const load = useCallback(() => {
    return fetch(`/api/calculation-strategies/${strategyId}`)
      .then((r) => r.json())
      .then((j) => { if (j.ok) setData(j.data); else setError(j.error ?? "Could not load."); })
      .catch(() => setError("Could not load."));
  }, [strategyId]);

  useEffect(() => {
    let live = true;
    fetch(`/api/calculation-strategies/${strategyId}`)
      .then((r) => r.json())
      .then((j) => { if (live) { if (j.ok) setData(j.data); else setError(j.error ?? "Could not load."); } })
      .catch(() => live && setError("Could not load."));
    return () => { live = false; };
  }, [strategyId]);

  const saveRate = async (programId: string, value: string) => {
    setSavingRate(programId);
    try {
      const res = await fetch(`/api/calculation-strategies/${strategyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rateOverrides: { [programId]: value === "" ? null : value } }),
      });
      if (res.ok) {
        await load(); // refresh the drawer's own numbers
        router.refresh(); // refresh the grid's computed columns
      }
    } finally {
      setSavingRate(null);
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-auto border-l border-[var(--color-rule-strong)] bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-[var(--color-rule)] px-4 py-3">
        <div>
          <div className="eyebrow text-[var(--color-text-soft)]">Calculation</div>
          <div className="text-lg font-semibold">{row ? `${row.individualName} — ${row.label}` : "Strategy"}</div>
          {row?.periodStart && <div className="text-xs text-[var(--color-text-soft)]">Budget period {row.periodStart} → {row.periodEnd} (from renewal date)</div>}
        </div>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 text-lg hover:bg-black/5" aria-label="Close">×</button>
      </div>
      <div className="px-4 py-3 text-sm">
        {error && <div className="text-red-600">{error}</div>}
        {!data && !error && <div className="text-[var(--color-text-soft)]">Loading…</div>}
        {data && (
          <>
            <div className="eyebrow mb-1 text-[var(--color-text-soft)]">Program rates — yearly gross = Σ (hours × rate)</div>
            <table className="mb-3 w-full text-xs">
              <thead>
                <tr className="text-[var(--color-text-soft)]">
                  <th className="py-0.5 text-left font-medium">Program</th>
                  <th className="py-0.5 text-right font-medium">Hours</th>
                  <th className="py-0.5 text-right font-medium">Rate /hr</th>
                  <th className="py-0.5 text-right font-medium">Gross</th>
                </tr>
              </thead>
              <tbody>
                {data.explain.lineGross.map((l, i) => (
                  <tr key={i} className="border-t border-[var(--color-rule)]">
                    <td className="py-1">{l.programLabel}</td>
                    <td className="py-1 text-right tabular-nums">{formatHours(l.hours)}</td>
                    <td className="py-1 text-right">
                      {canManage && l.programId ? (
                        <span className="inline-flex items-center justify-end gap-1">
                          <input
                            type="number"
                            step="any"
                            defaultValue={dec(l.rate).toString()}
                            disabled={savingRate === l.programId}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v !== dec(l.rate).toString()) saveRate(l.programId!, v);
                            }}
                            className="w-16 rounded border border-[var(--color-rule-strong)] px-1 py-0.5 text-right tabular-nums"
                            title={l.isOverride ? `Override. Default is ${formatMoney(l.defaultRate)}. Clear to use default.` : "Default rate. Type to override for this strategy."}
                          />
                          <span className={`rounded px-1 text-[10px] ${l.isOverride ? "bg-[var(--color-warn-soft)] text-[var(--color-warn)]" : "bg-[var(--color-surface-strong)] text-[var(--color-text-soft)]"}`}>
                            {l.isOverride ? "override" : "default"}
                          </span>
                        </span>
                      ) : (
                        <span className="tabular-nums">{formatMoney(l.rate)}{l.isOverride ? " *" : ""}</span>
                      )}
                    </td>
                    <td className="py-1 text-right tabular-nums font-medium">{formatMoney(l.gross)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canManage && (
              <p className="mb-3 text-[11px] text-[var(--color-text-soft)]">
                Type a rate to override it for this strategy; clear the box to return to the program default. Changing a rate recalculates everything instantly.
              </p>
            )}
            <div className="space-y-1.5">
              {data.explain.steps.map((s) => (
                <div key={s.key} className="flex items-baseline justify-between gap-3 border-b border-[var(--color-rule)] py-1">
                  <div><div className="font-medium">{s.label}</div><div className="text-xs text-[var(--color-text-soft)]">{s.formula}</div></div>
                  <div className="tabular-nums font-semibold">{s.value ? formatMoney(s.value) : "—"}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 space-y-1.5 border-t border-[var(--color-rule)] pt-3">
              <div className="eyebrow text-[var(--color-text-soft)]">Open</div>
              {row && <Link href={`/individuals/${row.individualId}`} className="block text-[var(--color-primary)] hover:underline">Individual profile →</Link>}
              {row && <Link href={`/transactions`} className="block text-[var(--color-primary)] hover:underline">Billed transactions →</Link>}
              <Link href={`/schedule`} className="block text-[var(--color-primary)] hover:underline">Schedule →</Link>
            </div>

            <div className="mt-4 border-t border-[var(--color-rule)] pt-3">
              <div className="eyebrow mb-1 text-[var(--color-text-soft)]">Change history ({data.revisions.length})</div>
              {data.revisions.length === 0 && <div className="text-xs text-[var(--color-text-soft)]">No edits yet.</div>}
              {data.revisions.map((rv) => (
                <div key={rv.id} className="flex justify-between py-0.5 text-xs">
                  <span>Revision {rv.revision}{rv.reason ? ` — ${rv.reason}` : ""}</span>
                  <span className="text-[var(--color-text-soft)]">{new Date(rv.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
