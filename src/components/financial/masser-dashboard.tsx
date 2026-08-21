"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { dec, formatMoney } from "@/lib/money";
import type { FinancialDashboard, FinancialDashboardRow, BudgetCandidate } from "@/lib/data/financial-dashboard";
import { useGrid } from "@/components/data-grid/use-grid";
import { Toolbar } from "@/components/data-grid/toolbar";
import { FilterBar, HeaderFilter } from "@/components/data-grid/filter-bar";
import SortMenu from "@/components/data-grid/sort-menu";
import { formatCell } from "@/components/data-grid/engine";
import { isNumericKind, type ColumnDef } from "@/components/data-grid/types";
import { Modal } from "@/components/manage/client";

/**
 * The Masser board — the money side across the whole budgeted roster, built on
 * the shared data-grid engine so it behaves exactly like Transactions: search,
 * per-column sort and filter, a column chooser, saved views, CSV/Excel export,
 * resizable columns and live filter-aware totals. On top of that it adds the
 * things this board needs: a this-year ⇄ all-time toggle for the actuals, phone
 * / account / notes editable inline on each person, and an "Add budget" action
 * that starts a plan from someone already in the transactions (or a new person).
 * Only people who HAVE a budget appear; everyone else is a candidate to add.
 */

type Period = "period" | "all";

interface Totals {
  masser: string;
  employeesMade: string;
  agencyMade: string;
  billedTotal: string;
  taxes: string;
}

const WIDTHS: Record<string, number> = {
  individual: 190, category: 120, phone: 130, masser: 110, employeesMade: 140,
  agencyMade: 130, billedTotal: 130, taxes: 120, planNet: 130, planBilled: 130,
  hours: 90, renewal: 120, notes: 240,
};
const HIDDEN_DEFAULT = ["planNet", "planBilled", "hours", "renewal"];

export default function MasserDashboard({
  data,
  canManage,
}: {
  data: FinancialDashboard;
  canManage: boolean;
}) {
  const router = useRouter();
  const [period, setPeriod] = useState<Period>("period");
  const [rows, setRows] = useState<FinancialDashboardRow[]>(data.rows);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Adopt fresh server data after a router.refresh().
  const [seen, setSeen] = useState(data.rows);
  if (seen !== data.rows) { setSeen(data.rows); setRows(data.rows); }

  // Persist an inline edit of a person's side info to /api/individuals.
  const saveField = useCallback(
    async (id: string, field: "phone" | "category" | "notes", value: string) => {
      const row = rows.find((r) => r.individualId === id);
      if (!row) return;
      const trimmed = value.trim();
      if (trimmed === ((row[field] ?? "") as string).trim()) return;
      const prevVal = (row[field] ?? null) as string | null;
      setRows((prev) => prev.map((r) => (r.individualId === id ? { ...r, [field]: trimmed || null } : r)));
      setSaving((prev) => new Set(prev).add(id + field));
      setNotice(null);
      try {
        const res = await fetch(`/api/individuals/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [field]: trimmed === "" ? null : trimmed }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save.");
      } catch (e) {
        setRows((prev) => prev.map((r) => (r.individualId === id ? { ...r, [field]: prevVal } : r)));
        setNotice(e instanceof Error ? e.message : "Could not save the change.");
      } finally {
        setSaving((prev) => { const n = new Set(prev); n.delete(id + field); return n; });
      }
    },
    [rows],
  );

  // Columns. The actual-money columns read the period-selected field, so the
  // whole grid — sort, filter, totals, export — follows the toggle.
  const columns = useMemo<ColumnDef<FinancialDashboardRow>[]>(() => {
    const A = <K extends string>(p: K, a: K) => (period === "period" ? p : a);
    const editable = (
      key: "category" | "phone" | "notes",
      label: string,
      width: number,
      kind: "text",
    ): ColumnDef<FinancialDashboardRow> => ({
      key, label, kind, width,
      accessor: (r) => r[key],
      render: (r) => (
        <EditableCell
          value={r[key]}
          field={key}
          multiline={key === "notes"}
          badge={key === "category"}
          canManage={canManage}
          saving={saving.has(r.individualId + key)}
          onSave={(v) => saveField(r.individualId, key, v)}
        />
      ),
    });

    return [
      {
        key: "individual", label: "Individual", kind: "text", frozen: true, width: WIDTHS.individual,
        accessor: (r) => r.individualName,
        render: (r) => (
          <span className="flex items-center gap-1.5">
            <Link href={`/individuals/${r.individualId}`} className="truncate font-medium text-[var(--color-primary)] hover:underline" onClick={(e) => e.stopPropagation()} title={`Open ${r.individualName}`}>
              {r.individualName}
            </Link>
            {!r.active ? <span className="shrink-0 rounded bg-[var(--color-surface-strong)] px-1 text-[10px] text-[var(--color-text-soft)]">inactive</span> : null}
            {r.strategyCount > 1 ? <span className="shrink-0 rounded bg-[var(--color-surface-strong)] px-1 text-[10px] text-[var(--color-text-soft)]" title={`${r.strategyCount} plans`}>{r.strategyCount}×</span> : null}
          </span>
        ),
      },
      editable("category", "Account?", WIDTHS.category, "text"),
      editable("phone", "Phone", WIDTHS.phone, "text"),
      { key: "masser", label: "Masser", kind: "money", width: WIDTHS.masser, accessor: (r) => r.masser,
        render: (r) => (r.masser ? <span className="font-medium text-[var(--color-warn)]">{formatMoney(r.masser)}</span> : <span className="text-[var(--color-text-soft)]">—</span>) },
      { key: "employeesMade", label: "Employees made", kind: "money", width: WIDTHS.employeesMade, accessor: (r) => A(r.employeesMadePeriod, r.employeesMadeAll) },
      { key: "agencyMade", label: "Agency made", kind: "money", width: WIDTHS.agencyMade, accessor: (r) => A(r.agencyMadePeriod, r.agencyMadeAll),
        render: (r, t) => <span className="text-[var(--color-success)]">{t}</span> },
      { key: "billedTotal", label: "Total billed", kind: "money", width: WIDTHS.billedTotal, accessor: (r) => A(r.billedGrossPeriod, r.billedGrossAll),
        render: (r, t) => <span className="font-medium">{t}</span> },
      { key: "taxes", label: "Taxes", kind: "money", width: WIDTHS.taxes, accessor: (r) => A(r.taxesPeriod, r.taxesAll),
        render: (r, t) => <span className="text-[var(--color-ink-soft)]">{t}</span> },
      { key: "planNet", label: "Net / yr (plan)", kind: "money", width: WIDTHS.planNet, hidden: true, accessor: (r) => r.planNetYearly },
      { key: "planBilled", label: "Plan billed / yr", kind: "money", width: WIDTHS.planBilled, hidden: true, accessor: (r) => r.planYearlyGross },
      { key: "hours", label: "Hours billed", kind: "hours", width: WIDTHS.hours, hidden: true, accessor: (r) => A(r.hoursPeriod, r.hoursAll) },
      { key: "renewal", label: "Renews", kind: "date", width: WIDTHS.renewal, hidden: true, accessor: (r) => r.renewalDate },
      editable("notes", "Notes", WIDTHS.notes, "text"),
    ];
  }, [period, canManage, saveField, saving]);

  const grid = useGrid<FinancialDashboardRow, Totals>({
    rows,
    columns,
    gridKey: "masser",
    canManage,
    initialSort: [{ key: "billedTotal", dir: "desc" }],
    initialHidden: HIDDEN_DEFAULT,
    initialWidths: WIDTHS,
    searchKeys: ["individual", "category", "phone", "notes"],
    serializeHidden: true,
    serializeWidths: true,
    computeTotals: (filtered) => {
      let mas = dec(0), emp = dec(0), ag = dec(0), tot = dec(0), tax = dec(0);
      for (const r of filtered) {
        if (r.masser) mas = mas.plus(dec(r.masser));
        emp = emp.plus(dec(period === "period" ? r.employeesMadePeriod : r.employeesMadeAll));
        ag = ag.plus(dec(period === "period" ? r.agencyMadePeriod : r.agencyMadeAll));
        tot = tot.plus(dec(period === "period" ? r.billedGrossPeriod : r.billedGrossAll));
        tax = tax.plus(dec(period === "period" ? r.taxesPeriod : r.taxesAll));
      }
      return { masser: mas.toFixed(2), employeesMade: emp.toFixed(2), agencyMade: ag.toFixed(2), billedTotal: tot.toFixed(2), taxes: tax.toFixed(2) };
    },
  });

  const { visibleColumns, sorted, widths } = grid;
  const colW = (c: ColumnDef<FinancialDashboardRow>) => widths[c.key] ?? c.width ?? 120;
  const totals = grid.totals;

  // frozen-left offsets
  const frozenLeft = useMemo(() => {
    const map: Record<string, number> = {};
    let left = 0;
    for (const c of visibleColumns) { if (!c.frozen) break; map[c.key] = left; left += widths[c.key] ?? c.width ?? 120; }
    return map;
  }, [visibleColumns, widths]);

  // column resize
  const setWidth = grid.setWidth;
  const dragRef = useRef<{ key: string; startX: number; startW: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => { const d = dragRef.current; if (d) setWidth(d.key, Math.max(64, d.startW + (e.clientX - d.startX))); };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [setWidth]);

  const tableWidth = visibleColumns.reduce((s, c) => s + colW(c), 0);
  const tile = "rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2";
  const periodLabel = period === "period" ? "this budget year" : "all time";

  return (
    <div className="space-y-3">
      {/* Period toggle + Add budget */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-0.5 text-sm">
          <button type="button" onClick={() => setPeriod("period")} aria-pressed={period === "period"}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${period === "period" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}>
            This budget year
          </button>
          <button type="button" onClick={() => setPeriod("all")} aria-pressed={period === "all"}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${period === "all" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}>
            All time
          </button>
        </div>
        <span className="text-sm text-[var(--color-text-soft)]">Actuals for <span className="font-medium text-[var(--color-ink)]">{periodLabel}</span></span>
        {canManage ? (
          <button type="button" onClick={() => setAddOpen(true)} className="btn btn-sm btn-primary ml-auto">+ Add budget</button>
        ) : null}
      </div>

      {/* Shared toolbar: search, saved views, column chooser, export */}
      <Toolbar
        grid={grid}
        searchPlaceholder="Search a person, account or note…"
        exportEndpoint="/api/grid/export"
        exportTitle="Masser board"
        exportFilename="masser"
        showColumnChooser
      />

      <FilterBar grid={grid} />

      {/* Filter-aware, period-aware totals */}
      {totals ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Employees made</div><div className="text-xl font-semibold tabular-nums text-[var(--color-primary)]">{formatMoney(totals.employeesMade)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Agency made</div><div className="text-xl font-semibold tabular-nums text-[var(--color-success)]">{formatMoney(totals.agencyMade)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Total billed</div><div className="text-xl font-semibold tabular-nums">{formatMoney(totals.billedTotal)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Taxes (withheld)</div><div className="text-xl font-semibold tabular-nums">{formatMoney(totals.taxes)}</div></div>
          <div className={tile}><div className="eyebrow text-[var(--color-text-soft)]">Masser (put away)</div><div className="text-xl font-semibold tabular-nums text-[var(--color-warn)]">{formatMoney(totals.masser)}</div></div>
        </div>
      ) : null}

      {notice ? <div className="rounded border border-[var(--color-danger)] bg-[#fdf2f5] px-3 py-1.5 text-sm text-[var(--color-danger)]">{notice}</div> : null}

      <p className="text-xs text-[var(--color-text-soft)]">
        <span className="font-medium text-[var(--color-ink-soft)]">Employees made</span> + <span className="font-medium text-[var(--color-ink-soft)]">Agency made</span> = Total billed (the agency&rsquo;s billed-rate spread over the budget rate). <span className="font-medium text-[var(--color-ink-soft)]">Taxes</span> is the real withholding on checks paid to the employee (gross − net), kept separately. <span className="font-medium text-[var(--color-ink-soft)]">Masser</span> is each plan&rsquo;s fixed set-aside.
        {canManage ? " Click a phone, account or note to edit it." : ""}
      </p>

      {/* Grid */}
      <div className="scroll-thin relative max-h-[64vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]">
        <table className="border-collapse text-sm" style={{ tableLayout: "fixed", width: tableWidth }}>
          <colgroup>{visibleColumns.map((c) => <col key={c.key} style={{ width: colW(c) }} />)}</colgroup>
          <thead className="sticky top-0 z-20">
            <tr>
              {visibleColumns.map((c) => {
                const s = grid.sort.find((x) => x.key === c.key);
                const isFrozen = c.key in frozenLeft;
                const numeric = isNumericKind(c.kind);
                return (
                  <th key={c.key} aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : "none"}
                    className={`relative border-b border-r border-[var(--color-rule-strong)] bg-[var(--color-surface-strong,#f1efe9)] px-2 py-1.5 align-middle font-semibold ${numeric ? "text-right" : "text-left"}`}
                    style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 30 } : undefined}>
                    <div className={`flex items-center gap-1 ${numeric ? "flex-row-reverse" : ""}`}>
                      <span className="flex-1 whitespace-normal break-words leading-tight">{c.label}</span>
                      <SortMenu label={c.label} numeric={numeric} dir={s ? s.dir : null} onSort={(dir) => grid.sortColumn(c.key, dir)} />
                      <HeaderFilter grid={grid} col={c} />
                    </div>
                    <span onMouseDown={(e) => { e.preventDefault(); dragRef.current = { key: c.key, startX: e.clientX, startW: colW(c) }; }}
                      title="Drag to resize" className="absolute right-0 top-0 h-full w-2 cursor-col-resize select-none border-r-2 border-transparent hover:border-[var(--color-primary)]" />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.individualId} className="hover:bg-black/[0.02]">
                {visibleColumns.map((c) => {
                  const isFrozen = c.key in frozenLeft;
                  const numeric = isNumericKind(c.kind);
                  const text = formatCell(c, r);
                  return (
                    <td key={c.key}
                      className={`overflow-hidden border-b border-r border-[var(--color-rule)] px-2 py-1 align-top ${numeric ? "text-right tabular-nums" : "text-left"} ${c.key === "notes" ? "whitespace-normal" : "whitespace-nowrap text-ellipsis"}`}
                      style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 10, background: "var(--color-surface)" } : undefined}>
                      {c.render ? c.render(r, text, { editing: false, canManage }) : (text || <span className="text-[var(--color-text-soft)]">—</span>)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {sorted.length === 0 ? (
              <tr><td colSpan={visibleColumns.length} className="px-3 py-10 text-center text-[var(--color-text-soft)]">
                {rows.length === 0 ? "No budgets yet. Use “Add budget” to start one from someone in your transactions." : "No one matches the current filters."}
              </td></tr>
            ) : null}
          </tbody>
          {sorted.length > 0 && totals ? (
            <tfoot className="sticky bottom-0 z-20">
              <tr className="border-t-2 border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] font-semibold">
                {visibleColumns.map((c) => {
                  const isFrozen = c.key in frozenLeft;
                  const val =
                    c.key === "individual" ? `Total · ${sorted.length}` :
                    c.key === "masser" ? formatMoney(totals.masser) :
                    c.key === "employeesMade" ? formatMoney(totals.employeesMade) :
                    c.key === "agencyMade" ? formatMoney(totals.agencyMade) :
                    c.key === "billedTotal" ? formatMoney(totals.billedTotal) :
                    c.key === "taxes" ? formatMoney(totals.taxes) : "";
                  const numeric = isNumericKind(c.kind);
                  return (
                    <td key={c.key}
                      className={`border-r border-[var(--color-rule)] px-2 py-1.5 ${numeric ? "text-right tabular-nums" : "text-left"} ${c.key === "agencyMade" ? "text-[var(--color-success)]" : c.key === "masser" ? "text-[var(--color-warn)]" : ""}`}
                      style={isFrozen ? { position: "sticky", left: frozenLeft[c.key], zIndex: 10, background: "var(--color-surface-strong)" } : undefined}>
                      {val}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {addOpen ? (
        <AddBudgetModal candidates={data.candidates} onClose={() => setAddOpen(false)} onDone={() => { setAddOpen(false); router.refresh(); }} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ inline cell */

function EditableCell({
  value, field, multiline, badge, canManage, saving, onSave,
}: {
  value: string | null;
  field: string;
  multiline?: boolean;
  badge?: boolean;
  canManage: boolean;
  saving: boolean;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    const commit = (v: string) => { setEditing(false); onSave(v); };
    return multiline ? (
      <textarea autoFocus defaultValue={value ?? ""} rows={2} placeholder="Notes…"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit((e.target as HTMLTextAreaElement).value); } else if (e.key === "Escape") { e.preventDefault(); setEditing(false); } }}
        onBlur={(e) => commit(e.target.value)}
        className="w-full rounded border border-[var(--color-primary)] bg-white px-1.5 py-1 text-sm outline-none" />
    ) : (
      <input autoFocus defaultValue={value ?? ""} placeholder={`${field}…`}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit((e.target as HTMLInputElement).value); } else if (e.key === "Escape") { e.preventDefault(); setEditing(false); } }}
        onBlur={(e) => commit(e.target.value)}
        className="w-full rounded border border-[var(--color-primary)] bg-white px-1.5 py-0.5 text-sm outline-none" />
    );
  }
  const display =
    value == null || value === ""
      ? <span className="text-[var(--color-text-soft)]">{canManage ? (multiline ? "add a note…" : "—") : "—"}</span>
      : badge
        ? <span className="rounded bg-[var(--color-primary-tint)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-primary)]">{value}</span>
        : <span className={multiline ? "line-clamp-2 whitespace-pre-wrap text-xs text-[var(--color-ink-soft)]" : "tnum"}>{value}</span>;
  return (
    <button type="button" disabled={!canManage} onClick={() => canManage && setEditing(true)}
      title={canManage ? "Click to edit" : undefined}
      className={`block w-full text-left ${canManage ? "cursor-text hover:bg-[var(--color-primary-tint)]/40" : "cursor-default"} rounded px-0.5`}>
      {display}{saving ? <span className="ml-1 text-[10px] text-[var(--color-text-soft)]">…</span> : null}
    </button>
  );
}

/* ------------------------------------------------------------ add budget */

function AddBudgetModal({
  candidates, onClose, onDone,
}: {
  candidates: BudgetCandidate[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newRenewal, setNewRenewal] = useState("");

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    const list = n ? candidates.filter((c) => c.name.toLowerCase().includes(n)) : candidates;
    return list.slice(0, 40);
  }, [q, candidates]);

  const addExisting = async (c: BudgetCandidate) => {
    setBusy(c.id); setErr(null);
    try {
      const res = await fetch("/api/calculation-strategies", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ individualId: c.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not add the budget.");
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not add the budget."); setBusy(null); }
  };

  const createNew = async () => {
    const name = newName.trim();
    if (!name) { setErr("Enter a name for the new person."); return; }
    setBusy("new"); setErr(null);
    try {
      const res = await fetch("/api/individuals", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: name, ...(newRenewal ? { renewalDate: newRenewal } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not create the person.");
      // If no renewal was given, the individual has no strategy yet — seed one.
      if (!newRenewal && j.data?.id) {
        await fetch("/api/calculation-strategies", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ individualId: j.data.id }),
        });
      }
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not create the person."); setBusy(null); }
  };

  return (
    <Modal title="Add a budget" onClose={onClose}>
      <div className="space-y-4">
        {err ? <p className="rounded border border-[var(--color-danger)] bg-[#fdf2f5] px-3 py-2 text-sm text-[var(--color-danger)]">{err}</p> : null}

        <div>
          <p className="mb-1 text-sm font-medium">From someone already in your transactions</p>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a person…" className="input w-full" autoFocus />
          <div className="scroll-thin mt-2 max-h-64 overflow-auto rounded-lg border border-[var(--color-rule)]">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-[var(--color-text-soft)]">{candidates.length === 0 ? "Everyone already has a budget." : "No match."}</p>
            ) : filtered.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 border-b border-[var(--color-rule)] px-3 py-2 last:border-0">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{c.name}</div>
                  <div className="text-xs text-[var(--color-text-soft)]">{c.txCount.toLocaleString()} transaction{c.txCount === 1 ? "" : "s"} · {formatMoney(c.billed)} billed</div>
                </div>
                <button type="button" disabled={!!busy} onClick={() => addExisting(c)} className="btn btn-sm btn-secondary shrink-0">
                  {busy === c.id ? "Adding…" : "Add budget"}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-[var(--color-rule)] pt-3">
          <p className="mb-1 text-sm font-medium">Or create a new person</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block flex-1 text-sm"><span className="text-xs text-[var(--color-ink-soft)]">Name</span>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Full name" className="input mt-1 w-full" /></label>
            <label className="block text-sm"><span className="text-xs text-[var(--color-ink-soft)]">Renewal date (optional)</span>
              <input type="date" value={newRenewal} onChange={(e) => setNewRenewal(e.target.value)} className="input mt-1" /></label>
            <button type="button" disabled={!!busy} onClick={createNew} className="btn btn-sm btn-primary">{busy === "new" ? "Creating…" : "Create + budget"}</button>
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-soft)]">Creates the person and an empty budget; add programs, hours and cuts on their profile or the Financial sheet.</p>
        </div>
      </div>
    </Modal>
  );
}
