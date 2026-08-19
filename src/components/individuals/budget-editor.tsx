"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { dec, formatMoney, formatHours } from "@/lib/money";
import { BUDGET_STATUS_PRESENT, budgetStatusFromHours, type BudgetLineStatus } from "@/lib/business/budget-status";
import { txLink } from "@/lib/nav/tx-link";

/**
 * The per-individual budget, editable right on the profile — shaped like the
 * paper rollover sheet: Program · Per Hour · Hours · Total, with Used and Left
 * beside it so you always see where the year is up to. Managers type the rate
 * and hours; the total and what's left recompute as they type. Add or remove a
 * program, set the renewal date, and flip the account active/inactive — all
 * without leaving the page.
 */

export type BudgetEditorLine = {
  programId: string;
  programName: string;
  perHour: string;
  authorizedHours: string;
  usedHours: string;
  inPlan: boolean;
};

type Program = { id: string; code: string; name: string; defaultRate: string };

type Row = { programId: string; programName: string; perHour: string; hours: string; used: string };

const clean = (s: string) => {
  try {
    return dec(s || "0").toString();
  } catch {
    return "0";
  }
};

function StatusPill({ status }: { status: BudgetLineStatus }) {
  const s = BUDGET_STATUS_PRESENT[status];
  return (
    <span className="badge" style={{ background: s.tint, color: s.color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

export default function BudgetEditor({
  individualId,
  strategyId,
  active: activeInitial,
  renewalDate,
  effectiveRenewal,
  monthsToRenewal,
  periodStart,
  periodEnd,
  lines,
  programs,
  canEdit,
}: {
  individualId: string;
  strategyId: string | null;
  active: boolean;
  renewalDate: string | null;
  effectiveRenewal: string | null;
  monthsToRenewal: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  lines: BudgetEditorLine[];
  programs: Program[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const defaultRate = useMemo(() => new Map(programs.map((p) => [p.id, clean(p.defaultRate)])), [programs]);

  const initialRows: Row[] = useMemo(
    () =>
      lines
        .filter((l) => l.inPlan)
        .map((l) => ({ programId: l.programId, programName: l.programName, perHour: clean(l.perHour), hours: clean(l.authorizedHours), used: l.usedHours })),
    [lines],
  );

  const [rows, setRows] = useState<Row[]>(initialRows);
  const [renewal, setRenewal] = useState<string>(renewalDate ?? "");
  const [active, setActive] = useState<boolean>(activeInitial);
  const [addSel, setAddSel] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingActive, setSavingActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // "How many hours/month to bill to finish by renewal" for a remaining amount.
  const months = monthsToRenewal && monthsToRenewal > 0 ? monthsToRenewal : null;
  const perMonth = (left: ReturnType<typeof dec>) => (months && left.greaterThan(0) ? left.dividedBy(months) : null);

  // A quick account-status switch that lives ON the profile (a setting inside
  // the individual): active accounts auto-roll their renewal; inactive freeze.
  const toggleActive = async () => {
    setSavingActive(true);
    try {
      await fetch(`/api/individuals/${individualId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: activeInitial ? "deactivate" : "restore" }),
      });
      router.refresh();
    } finally {
      setSavingActive(false);
    }
  };

  // Programs billed this period but not in the plan — offer to add them.
  const billedNotInPlan = lines.filter((l) => !l.inPlan && dec(l.usedHours).greaterThan(0));
  const usedByProgram = useMemo(() => new Map(lines.map((l) => [l.programId, l.usedHours])), [lines]);

  const inPlanIds = new Set(rows.map((r) => r.programId));
  const addable = programs.filter((p) => !inPlanIds.has(p.id));

  const rowTotal = (r: Row) => dec(r.perHour || 0).times(dec(r.hours || 0));
  const grandTotal = rows.reduce((s, r) => s.plus(rowTotal(r)), dec(0));
  const totalAuthorized = rows.reduce((s, r) => s.plus(dec(r.hours || 0)), dec(0));
  const totalUsed = rows.reduce((s, r) => s.plus(dec(r.used || 0)), dec(0));

  const setRow = (pid: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.programId === pid ? { ...r, ...patch } : r)));
  const removeRow = (pid: string) => setRows((rs) => rs.filter((r) => r.programId !== pid));
  const addProgram = (pid: string) => {
    const p = programs.find((x) => x.id === pid);
    if (!p) return;
    setRows((rs) => [...rs, { programId: p.id, programName: p.name, perHour: defaultRate.get(p.id) ?? "0", hours: "", used: usedByProgram.get(p.id) ?? "0" }]);
    setAddSel("");
  };

  const startEdit = () => {
    setRows(initialRows);
    setRenewal(renewalDate ?? "");
    setActive(activeInitial);
    setEditing(true);
    setNotice(null);
  };
  const cancel = () => {
    setRows(initialRows);
    setRenewal(renewalDate ?? "");
    setActive(activeInitial);
    setEditing(false);
    setNotice(null);
  };

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      // Create the plan first if the person has none yet.
      let sid = strategyId;
      if (!sid) {
        const res = await fetch("/api/calculation-strategies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ individualId }),
        });
        const j = await res.json();
        if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not create the plan.");
        sid = j.data.id as string;
      }

      const hours: Record<string, string> = {};
      const rateOverrides: Record<string, string> = {};
      for (const r of rows) {
        hours[r.programId] = r.hours.trim() === "" ? "0" : clean(r.hours);
        const def = defaultRate.get(r.programId) ?? "0";
        // Only store an override when it differs from the program's default rate.
        rateOverrides[r.programId] = dec(r.perHour || 0).equals(dec(def || 0)) ? "" : clean(r.perHour);
      }
      // Delete any plan line the user removed.
      for (const orig of initialRows) if (!rows.some((r) => r.programId === orig.programId)) hours[orig.programId] = "";

      const patch: Record<string, unknown> = { hours, rateOverrides };
      if ((renewal || "") !== (renewalDate ?? "")) patch.renewalDate = renewal || null;

      const res = await fetch(`/api/calculation-strategies/${sid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save the budget.");

      if (active !== activeInitial) {
        await fetch(`/api/individuals/${individualId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: active ? "restore" : "deactivate" }),
        });
      }
      setEditing(false);
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not save the budget.");
    } finally {
      setBusy(false);
    }
  };

  /* -------------------------------------------------------------- read-only */
  if (!editing) {
    return (
      <div className="card mb-6">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3">
          <div>
            <p className="font-semibold text-[var(--color-ink)]">Budget by program</p>
            <p className="text-xs text-[var(--color-ink-faint)]">
              The plan for this renewal year. Renews {effectiveRenewal ?? "—"}
              {activeInitial ? "" : " · account inactive (renewal is not auto-rolling)"}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canEdit ? (
              <button
                type="button"
                onClick={toggleActive}
                disabled={savingActive}
                title={activeInitial ? "Active — renewal auto-rolls each year. Click to make inactive." : "Inactive — renewal is frozen. Click to make active."}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                  activeInitial ? "bg-[var(--color-success-soft)] text-[var(--color-success)]" : "bg-[var(--color-surface-strong)] text-[var(--color-ink-soft)]"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${activeInitial ? "bg-[var(--color-success)]" : "bg-[var(--color-ink-faint)]"}`} />
                {savingActive ? "…" : activeInitial ? "Active" : "Inactive"}
              </button>
            ) : (
              <span className="text-xs text-[var(--color-ink-faint)]">{activeInitial ? "Active" : "Inactive"}</span>
            )}
            {canEdit ? (
              <button type="button" onClick={startEdit} className="btn btn-sm btn-secondary">Edit this budget</button>
            ) : null}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="px-5 py-6 text-sm text-[var(--color-ink-soft)]">
            No programs in the plan yet.{canEdit ? " Click “Edit this budget” to add the first one." : ""}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[var(--color-text-soft)]">
                  <th className="px-5 py-2 font-medium">Program</th>
                  <th className="px-3 py-2 text-right font-medium">Per hour</th>
                  <th className="px-3 py-2 text-right font-medium">Hours</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">Used</th>
                  <th className="px-3 py-2 text-right font-medium">Left</th>
                  <th className="px-3 py-2 text-right font-medium" title="Hours to bill each month to finish by renewal">Per month{months ? " to finish" : ""}</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const left = dec(r.hours || 0).minus(dec(r.used || 0));
                  const pm = perMonth(left);
                  const status = budgetStatusFromHours(Number(r.hours || 0), Number(r.used || 0));
                  return (
                    <tr key={r.programId} className="border-t border-[var(--color-rule)]">
                      <td className="px-5 py-2 font-medium">
                        <Link className="text-[var(--color-primary)] hover:underline" href={txLink({ individualId, program: r.programName, pbFrom: periodStart ?? undefined, pbTo: periodEnd ?? undefined })}>{r.programName}</Link>
                      </td>
                      <td className="tnum px-3 py-2 text-right">{formatMoney(r.perHour)}</td>
                      <td className="tnum px-3 py-2 text-right">{formatHours(r.hours)}</td>
                      <td className="tnum px-3 py-2 text-right font-medium">{formatMoney(rowTotal(r).toString())}</td>
                      <td className="tnum px-3 py-2 text-right">{formatHours(r.used)}</td>
                      <td className="tnum px-3 py-2 text-right" style={{ color: left.isNegative() ? "var(--color-pace-over)" : undefined }}>{formatHours(left.toString())}</td>
                      <td className="tnum px-3 py-2 text-right text-[var(--color-ink-soft)]">{pm ? `${formatHours(pm.toString())}/mo` : "—"}</td>
                      <td className="px-5 py-2"><StatusPill status={status} /></td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-[var(--color-rule-strong)] font-semibold">
                  <td className="px-5 py-2">Total</td>
                  <td></td>
                  <td className="tnum px-3 py-2 text-right">{formatHours(totalAuthorized.toString())}</td>
                  <td className="tnum px-3 py-2 text-right">{formatMoney(grandTotal.toString())}</td>
                  <td className="tnum px-3 py-2 text-right">{formatHours(totalUsed.toString())}</td>
                  <td className="tnum px-3 py-2 text-right">{formatHours(totalAuthorized.minus(totalUsed).toString())}</td>
                  <td className="tnum px-3 py-2 text-right">{perMonth(totalAuthorized.minus(totalUsed)) ? `${formatHours(perMonth(totalAuthorized.minus(totalUsed))!.toString())}/mo` : "—"}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {canEdit && billedNotInPlan.length > 0 ? (
          <p className="border-t border-[var(--color-rule)] px-5 py-2.5 text-xs text-[var(--color-ink-faint)]">
            Billed this year but not in the plan: {billedNotInPlan.map((l) => `${l.programName} (${formatHours(l.usedHours)} h)`).join(", ")}. Edit the budget to add them.
          </p>
        ) : null}
      </div>
    );
  }

  /* ---------------------------------------------------------------- editing */
  return (
    <div className="card mb-6 border-[var(--color-primary-soft)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-rule)] bg-[var(--color-primary-tint)] px-5 py-3">
        <p className="font-semibold text-[var(--color-ink)]">Editing this person&rsquo;s budget</p>
        <div className="flex gap-2">
          <button type="button" onClick={cancel} disabled={busy} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="button" onClick={save} disabled={busy} className="btn btn-sm btn-primary">{busy ? "Saving…" : "Save budget"}</button>
        </div>
      </div>

      {notice ? <p className="border-b border-[var(--color-rule)] bg-[var(--color-danger-soft)] px-5 py-2 text-sm text-[var(--color-danger)]">{notice}</p> : null}

      {/* Renewal + active */}
      <div className="grid gap-4 border-b border-[var(--color-rule)] px-5 py-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Renewal date</span>
          <input type="date" value={renewal} onChange={(e) => setRenewal(e.target.value)} className="input mt-1 w-full" />
          <span className="mt-1 block text-xs text-[var(--color-ink-faint)]">
            The budget runs the 12 months up to this date. For an active account it auto-rolls to the next year when it passes.
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="mt-1" />
          <span>
            <span className="font-medium">Account is active</span>
            <span className="mt-1 block text-xs text-[var(--color-ink-faint)]">
              Active accounts auto-roll their renewal forward each year. Uncheck to make the account inactive and freeze the renewal date where it is.
            </span>
          </span>
        </label>
      </div>

      {/* Program lines */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[var(--color-text-soft)]">
              <th className="px-5 py-2 font-medium">Program</th>
              <th className="px-3 py-2 text-right font-medium">Per hour</th>
              <th className="px-3 py-2 text-right font-medium">Hours</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 text-right font-medium">Used</th>
              <th className="px-3 py-2 text-right font-medium">Left</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const left = dec(r.hours || 0).minus(dec(r.used || 0));
              return (
                <tr key={r.programId} className="border-t border-[var(--color-rule)]">
                  <td className="px-5 py-2 font-medium">{r.programName}</td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-1">
                      <span className="text-[var(--color-ink-faint)]">$</span>
                      <input type="number" step="any" value={r.perHour} onChange={(e) => setRow(r.programId, { perHour: e.target.value })} className="input w-20 text-right tabular-nums" />
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input type="number" step="any" value={r.hours} onChange={(e) => setRow(r.programId, { hours: e.target.value })} className="input w-24 text-right tabular-nums" />
                  </td>
                  <td className="tnum px-3 py-2 text-right font-medium">{formatMoney(rowTotal(r).toString())}</td>
                  <td className="tnum px-3 py-2 text-right text-[var(--color-ink-soft)]">{formatHours(r.used)}</td>
                  <td className="tnum px-3 py-2 text-right" style={{ color: left.isNegative() ? "var(--color-pace-over)" : undefined }}>{formatHours(left.toString())}</td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" onClick={() => removeRow(r.programId)} className="text-[var(--color-ink-faint)] hover:text-[var(--color-danger)]" title="Remove this program" aria-label={`Remove ${r.programName}`}>✕</button>
                  </td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-[var(--color-rule-strong)] font-semibold">
              <td className="px-5 py-2">Total</td>
              <td></td>
              <td className="tnum px-3 py-2 text-right">{formatHours(totalAuthorized.toString())}</td>
              <td className="tnum px-3 py-2 text-right">{formatMoney(grandTotal.toString())}</td>
              <td className="tnum px-3 py-2 text-right">{formatHours(totalUsed.toString())}</td>
              <td className="tnum px-3 py-2 text-right">{formatHours(totalAuthorized.minus(totalUsed).toString())}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Add a program */}
      {addable.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-rule)] px-5 py-3">
          <span className="text-sm text-[var(--color-ink-soft)]">Add a program:</span>
          <select value={addSel} onChange={(e) => { setAddSel(e.target.value); if (e.target.value) addProgram(e.target.value); }} className="rounded border border-[var(--color-rule-strong)] bg-white px-2 py-1.5 text-sm">
            <option value="">Choose a program…</option>
            {addable.map((p) => (
              <option key={p.id} value={p.id}>{p.name} — ${clean(p.defaultRate)}/h</option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}
