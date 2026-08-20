"use client";

import { useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { dec, formatMoney } from "@/lib/money";
import type { FinancialDashboard, FinancialDashboardRow } from "@/lib/data/financial-dashboard";

/**
 * The Masser board grid. One row per individual, the money side at a glance,
 * with the plan reserves (Masser, the tax reserve) beside the actual money
 * billed (what the employees made, what the agency made, the total). A period
 * toggle swaps the actuals between this budget year and all-time; phone, the
 * account tag and notes are editable inline and saved straight to the person.
 */

type Period = "period" | "all";
type SortKey = "name" | "category" | "employees" | "agency" | "total" | "taxes" | "masser";
type SortDir = "asc" | "desc";

/** The actual-money figures for the active window (this budget year or all-time). */
function pick(row: FinancialDashboardRow, period: Period) {
  return period === "period"
    ? {
        employees: row.employeesMadePeriod,
        agency: row.agencyMadePeriod,
        total: row.billedGrossPeriod,
        taxes: row.taxesPeriod,
        tx: row.txCountPeriod,
      }
    : {
        employees: row.employeesMadeAll,
        agency: row.agencyMadeAll,
        total: row.billedGrossAll,
        taxes: row.taxesAll,
        tx: row.txCountAll,
      };
}

const num = (s: string | null | undefined) => Number(s ?? 0);

export default function MasserDashboard({ data, canManage }: { data: FinancialDashboard; canManage: boolean }) {
  const router = useRouter();
  const [period, setPeriod] = useState<Period>("period");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "total", dir: "desc" });
  const [rows, setRows] = useState<FinancialDashboardRow[]>(data.rows);
  const [editing, setEditing] = useState<{ id: string; field: "phone" | "category" | "notes" } | null>(null);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  // Keep local rows in sync when the server sends fresh data (e.g. after
  // router.refresh()) — the React-idiomatic "adjust state during render".
  const [seen, setSeen] = useState(data.rows);
  if (seen !== data.rows) {
    setSeen(data.rows);
    setRows(data.rows);
    setEditing(null);
  }

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? rows.filter(
          (r) =>
            r.individualName.toLowerCase().includes(needle) ||
            (r.category ?? "").toLowerCase().includes(needle) ||
            (r.phone ?? "").toLowerCase().includes(needle),
        )
      : rows.slice();
    const val = (r: FinancialDashboardRow): number | string => {
      const p = pick(r, period);
      switch (sort.key) {
        case "name": return r.individualName.toLowerCase();
        case "category": return (r.category ?? "").toLowerCase();
        case "employees": return num(p.employees);
        case "agency": return num(p.agency);
        case "total": return num(p.total);
        case "taxes": return num(p.taxes);
        case "masser": return num(r.masser);
      }
    };
    filtered.sort((a, b) => {
      const va = val(a), vb = val(b);
      let d = 0;
      if (typeof va === "number" && typeof vb === "number") d = va - vb;
      else d = String(va).localeCompare(String(vb));
      if (d === 0) d = a.individualName.localeCompare(b.individualName);
      return sort.dir === "asc" ? d : -d;
    });
    return filtered;
  }, [rows, q, sort, period]);

  // Filter-aware totals for the visible set.
  const totals = useMemo(() => {
    let emp = dec(0), ag = dec(0), tot = dec(0), tax = dec(0), mas = dec(0);
    for (const r of visible) {
      const p = pick(r, period);
      emp = emp.plus(dec(p.employees));
      ag = ag.plus(dec(p.agency));
      tot = tot.plus(dec(p.total));
      tax = tax.plus(dec(p.taxes));
      if (r.masser) mas = mas.plus(dec(r.masser));
    }
    return { employees: emp, agency: ag, total: tot, taxes: tax, masser: mas };
  }, [visible, period]);

  const saveField = useCallback(
    async (id: string, field: "phone" | "category" | "notes", value: string) => {
      const row = rows.find((r) => r.individualId === id);
      if (!row) return;
      const trimmed = value.trim();
      const current = (row[field] ?? "") as string;
      setEditing(null);
      if (trimmed === current.trim()) return; // no change
      // Optimistic update.
      setRows((prev) => prev.map((r) => (r.individualId === id ? { ...r, [field]: trimmed || null } : r)));
      setSaving((prev) => new Set(prev).add(id));
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
        // Revert on failure.
        setRows((prev) => prev.map((r) => (r.individualId === id ? { ...r, [field]: current || null } : r)));
        setNotice(e instanceof Error ? e.message : "Could not save the change.");
      } finally {
        setSaving((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [rows],
  );

  const toggleSort = (key: SortKey) =>
    setSort((p) =>
      p.key === key
        ? { key, dir: p.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" || key === "category" ? "asc" : "desc" },
    );

  const periodLabel = period === "period" ? "this budget year" : "all time";

  return (
    <div className="space-y-3">
      {/* Period toggle + explainer */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-[var(--color-rule-strong)] bg-[var(--color-surface)] p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setPeriod("period")}
            aria-pressed={period === "period"}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${period === "period" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}
          >
            This budget year
          </button>
          <button
            type="button"
            onClick={() => setPeriod("all")}
            aria-pressed={period === "all"}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${period === "all" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`}
          >
            All time
          </button>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a person, phone or account…"
          className="input w-64 max-w-full"
          aria-label="Search the Masser board"
        />
        <span className="text-sm text-[var(--color-text-soft)]">
          Showing <span className="tnum font-semibold text-[var(--color-ink)]">{visible.length}</span> of{" "}
          <span className="tnum">{rows.length}</span> · actuals for <span className="font-medium text-[var(--color-ink)]">{periodLabel}</span>
        </span>
      </div>

      {/* Totals tiles (filter-aware) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Employees made" value={formatMoney(totals.employees.toString())} color="var(--color-primary)" />
        <Tile label="Agency made" value={formatMoney(totals.agency.toString())} color="var(--color-success)" />
        <Tile label="Total billed" value={formatMoney(totals.total.toString())} />
        <Tile label="Taxes (reserve)" value={formatMoney(totals.taxes.toString())} />
        <Tile label="Masser (put away)" value={formatMoney(totals.masser.toString())} color="var(--color-warn)" />
      </div>

      {notice ? (
        <div className="rounded border border-[var(--color-pace-over)] bg-[#fdf2f5] px-3 py-1.5 text-sm text-[var(--color-pace-over)]">{notice}</div>
      ) : null}

      <p className="text-xs text-[var(--color-text-soft)]">
        <span className="font-medium text-[var(--color-ink-soft)]">Employees made</span> is the budget-rate value of the work; <span className="font-medium text-[var(--color-ink-soft)]">Agency made</span> is the billed-rate spread on top (e.g. $17 budget → $19 billed = $2). The two add up to the total billed.{" "}
        <span className="font-medium text-[var(--color-ink-soft)]">Masser</span> is each plan&rsquo;s fixed set-aside (the &ldquo;after all&rdquo;); <span className="font-medium text-[var(--color-ink-soft)]">Taxes</span> is the plan&rsquo;s first cut applied to what the employees made.
        {canManage ? " Click a phone, account or note to edit it." : ""}
      </p>

      {/* The board */}
      <div className="scroll-thin max-h-[68vh] overflow-auto rounded-lg border border-[var(--color-rule-strong)]">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              <SortHead k="name" sort={sort} onSort={toggleSort} sticky>Individual</SortHead>
              <SortHead k="category" sort={sort} onSort={toggleSort}>Account?</SortHead>
              <th className="whitespace-nowrap border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 text-left font-semibold">Phone</th>
              <SortHead k="employees" sort={sort} onSort={toggleSort} align="right">Employees made</SortHead>
              <SortHead k="agency" sort={sort} onSort={toggleSort} align="right">Agency made</SortHead>
              <SortHead k="total" sort={sort} onSort={toggleSort} align="right">Total billed</SortHead>
              <SortHead k="taxes" sort={sort} onSort={toggleSort} align="right">Taxes</SortHead>
              <SortHead k="masser" sort={sort} onSort={toggleSort} align="right">Masser</SortHead>
              <th className="whitespace-nowrap border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 text-left font-semibold" style={{ minWidth: 180 }}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const p = pick(r, period);
              const isSaving = saving.has(r.individualId);
              return (
                <tr key={r.individualId} className="border-b border-[var(--color-rule)] hover:bg-black/[0.015]">
                  <td className="sticky left-0 z-[1] bg-[var(--color-surface)] px-3 py-2" style={{ minWidth: 160 }}>
                    <Link href={`/individuals/${r.individualId}`} className="font-medium text-[var(--color-primary)] hover:underline" title={`Open ${r.individualName}`}>
                      {r.individualName}
                    </Link>
                    {!r.active ? <span className="ml-1.5 rounded bg-[var(--color-surface-strong)] px-1 text-[10px] text-[var(--color-text-soft)]">inactive</span> : null}
                    {r.strategyCount === 0 ? <span className="ml-1.5 rounded bg-[var(--color-warn-soft)] px-1 text-[10px] text-[var(--color-warn)]" title="No active plan — Masser and Taxes need a plan">no plan</span> : null}
                    {isSaving ? <span className="ml-1.5 text-[10px] text-[var(--color-text-soft)]">saving…</span> : null}
                  </td>
                  <EditableTextCell
                    value={r.category}
                    placeholder="—"
                    editing={!!editing && editing.id === r.individualId && editing.field === "category"}
                    canManage={canManage}
                    onStart={() => setEditing({ id: r.individualId, field: "category" })}
                    onCommit={(v) => saveField(r.individualId, "category", v)}
                    onCancel={() => setEditing(null)}
                    render={(val) => (val ? <span className="rounded bg-[var(--color-primary-tint)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-primary)]">{val}</span> : <span className="text-[var(--color-text-soft)]">—</span>)}
                  />
                  <EditableTextCell
                    value={r.phone}
                    placeholder="—"
                    editing={!!editing && editing.id === r.individualId && editing.field === "phone"}
                    canManage={canManage}
                    onStart={() => setEditing({ id: r.individualId, field: "phone" })}
                    onCommit={(v) => saveField(r.individualId, "phone", v)}
                    onCancel={() => setEditing(null)}
                    render={(val) => (val ? <span className="tnum">{val}</span> : <span className="text-[var(--color-text-soft)]">—</span>)}
                  />
                  <td className="tnum px-3 py-2 text-right">{formatMoney(p.employees)}</td>
                  <td className="tnum px-3 py-2 text-right text-[var(--color-success)]">{formatMoney(p.agency)}</td>
                  <td className="tnum px-3 py-2 text-right font-medium">{formatMoney(p.total)}</td>
                  <td className="tnum px-3 py-2 text-right text-[var(--color-ink-soft)]">{formatMoney(p.taxes)}</td>
                  <td className="tnum px-3 py-2 text-right">{r.masser ? <span className="font-medium text-[var(--color-warn)]">{formatMoney(r.masser)}</span> : <span className="text-[var(--color-text-soft)]">—</span>}</td>
                  <NotesCell
                    value={r.notes}
                    editing={!!editing && editing.id === r.individualId && editing.field === "notes"}
                    canManage={canManage}
                    onStart={() => setEditing({ id: r.individualId, field: "notes" })}
                    onCommit={(v) => saveField(r.individualId, "notes", v)}
                    onCancel={() => setEditing(null)}
                  />
                </tr>
              );
            })}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-[var(--color-text-soft)]">
                  {rows.length === 0 ? "No individuals to show yet." : "No one matches your search."}
                </td>
              </tr>
            ) : null}
          </tbody>
          {visible.length > 0 ? (
            <tfoot className="sticky bottom-0 z-10">
              <tr className="border-t-2 border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] font-semibold">
                <td className="sticky left-0 z-[1] bg-[var(--color-surface-strong)] px-3 py-2">Total · {visible.length}</td>
                <td /><td />
                <td className="tnum px-3 py-2 text-right">{formatMoney(totals.employees.toString())}</td>
                <td className="tnum px-3 py-2 text-right text-[var(--color-success)]">{formatMoney(totals.agency.toString())}</td>
                <td className="tnum px-3 py-2 text-right">{formatMoney(totals.total.toString())}</td>
                <td className="tnum px-3 py-2 text-right text-[var(--color-ink-soft)]">{formatMoney(totals.taxes.toString())}</td>
                <td className="tnum px-3 py-2 text-right text-[var(--color-warn)]">{formatMoney(totals.masser.toString())}</td>
                <td />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      <div className="flex justify-end">
        <button type="button" onClick={() => router.refresh()} className="btn btn-sm btn-ghost text-xs">Refresh</button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- bits */

function Tile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2">
      <div className="eyebrow text-[var(--color-text-soft)]">{label}</div>
      <div className="tnum text-lg font-semibold leading-tight" style={color ? { color } : undefined}>{value}</div>
    </div>
  );
}

function SortHead({
  k, sort, onSort, children, align = "left", sticky,
}: {
  k: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (k: SortKey) => void;
  children: React.ReactNode;
  align?: "left" | "right";
  sticky?: boolean;
}) {
  return (
    <th
      className={`whitespace-nowrap border-b border-[var(--color-rule-strong)] bg-[var(--color-surface-strong)] px-3 py-2 font-semibold ${align === "right" ? "text-right" : "text-left"} ${sticky ? "sticky left-0 z-[11]" : ""}`}
      style={sticky ? { minWidth: 160 } : undefined}
    >
      <button type="button" onClick={() => onSort(k)} className={`inline-flex items-center gap-1 hover:underline ${align === "right" ? "flex-row-reverse" : ""}`} title="Sort">
        {children}
        <span className="text-[10px] text-[var(--color-primary)]">{sort.key === k ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
      </button>
    </th>
  );
}

/** A one-line editable cell (phone, account tag). Click to edit; Enter/blur saves. */
function EditableTextCell({
  value, placeholder, editing, canManage, onStart, onCommit, onCancel, render,
}: {
  value: string | null;
  placeholder: string;
  editing: boolean;
  canManage: boolean;
  onStart: () => void;
  onCommit: (v: string) => void;
  onCancel: () => void;
  render: (val: string | null) => React.ReactNode;
}) {
  if (editing) {
    return (
      <td className="px-2 py-1">
        <input
          autoFocus
          defaultValue={value ?? ""}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onCommit((e.target as HTMLInputElement).value); }
            else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }}
          onBlur={(e) => onCommit(e.target.value)}
          className="w-full min-w-[80px] rounded border border-[var(--color-primary)] bg-white px-1.5 py-0.5 text-sm outline-none"
        />
      </td>
    );
  }
  return (
    <td
      className={`px-3 py-2 ${canManage ? "cursor-text" : ""}`}
      onClick={canManage ? onStart : undefined}
      title={canManage ? "Click to edit" : undefined}
    >
      {render(value)}
    </td>
  );
}

/** The notes cell: a truncated preview that expands to a textarea when editing. */
function NotesCell({
  value, editing, canManage, onStart, onCommit, onCancel,
}: {
  value: string | null;
  editing: boolean;
  canManage: boolean;
  onStart: () => void;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  if (editing) {
    return (
      <td className="px-2 py-1" style={{ minWidth: 180 }}>
        <textarea
          autoFocus
          defaultValue={value ?? ""}
          rows={2}
          placeholder="Notes…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit((e.target as HTMLTextAreaElement).value); }
            else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }}
          onBlur={(e) => onCommit(e.target.value)}
          className="w-full rounded border border-[var(--color-primary)] bg-white px-1.5 py-1 text-sm outline-none"
        />
      </td>
    );
  }
  return (
    <td
      className={`px-3 py-2 text-xs text-[var(--color-ink-soft)] ${canManage ? "cursor-text" : ""}`}
      onClick={canManage ? onStart : undefined}
      title={canManage ? (value ? value : "Click to add a note") : value ?? undefined}
      style={{ minWidth: 180, maxWidth: 280 }}
    >
      {value ? <span className="line-clamp-2 whitespace-pre-wrap">{value}</span> : <span className="text-[var(--color-text-soft)]">{canManage ? "add a note…" : "—"}</span>}
    </td>
  );
}
