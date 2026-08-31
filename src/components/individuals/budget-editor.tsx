"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { dec, formatMoney, formatHours } from "@/lib/money";
import { BUDGET_STATUS_PRESENT, budgetStatusFromHours, type BudgetLineStatus } from "@/lib/business/budget-status";
import { isCalendarYearProgram } from "@/lib/business/calculation-strategy";
import { txLink } from "@/lib/nav/tx-link";

/**
 * Editable financial projection inputs. These calculation-strategy lines are
 * deliberately separate from service authorizations; they price target hours
 * and cuts but never define the operational Budget balance.
 */

export type BudgetEditorLine = {
  programId: string;
  programName: string;
  perHour: string;
  authorizedHours: string;
  usedHours: string;
  inPlan: boolean;
  daysToRenewal: number | null;
  effectiveRenewal: string | null;
  calendarYear: boolean;
};

type Program = { id: string; code: string; name: string; defaultRate: string };

type Row = { programId: string; programName: string; perHour: string; hours: string; used: string; daysToRenewal: number | null; effectiveRenewal: string | null; calendarYear: boolean };

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
  periodStart,
  periodEnd,
  lines,
  programs,
  canEdit,
  canSeeMoney = true,
}: {
  individualId: string;
  strategyId: string | null;
  active: boolean;
  renewalDate: string | null;
  effectiveRenewal: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  lines: BudgetEditorLine[];
  programs: Program[];
  canEdit: boolean;
  canSeeMoney?: boolean;
}) {
  const router = useRouter();
  const defaultRate = useMemo(() => new Map(programs.map((p) => [p.id, clean(p.defaultRate)])), [programs]);

  const initialRows: Row[] = useMemo(
    () =>
      lines
        .filter((l) => l.inPlan)
        .map((l) => ({
          programId: l.programId,
          programName: l.programName,
          perHour: clean(l.perHour),
          hours: clean(l.authorizedHours),
          used: l.usedHours,
          daysToRenewal: l.daysToRenewal,
          effectiveRenewal: l.effectiveRenewal,
          calendarYear: l.calendarYear,
        })),
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

  // "How many hours/month to bill to finish" — per PROGRAM, each toward its own
  // renewal (Day Hab / Supplemental run the calendar year, so their months-left
  // differ from the rest of the plan).
  const rowMonths = (r: Row) => (r.daysToRenewal !== null && r.daysToRenewal > 0 ? r.daysToRenewal / 30.4375 : null);
  const rowLeft = (r: Row) => dec(r.hours || 0).minus(dec(r.used || 0));
  const perMonth = (r: Row) => {
    const m = rowMonths(r);
    const left = rowLeft(r);
    return m && left.greaterThan(0) ? left.dividedBy(m) : null;
  };
  const perMonthDollarsRow = (r: Row) => {
    const pm = perMonth(r);
    return pm ? pm.times(dec(r.perHour || 0)) : null;
  };

  // "To finish" pace that stays sensible near renewal. Dividing the hours left by
  // a FRACTION of a month inflates the rate above the hours left (66 h with 12
  // days left is not "168/month"). So under a month, show the real hours over the
  // real days ("66.4 h in 12d"); a month or more out, the monthly pace is fine.
  const finishLabel = (left: ReturnType<typeof dec>, days: number | null): string => {
    if (!left.greaterThan(0)) return "—";
    if (days === null) return "—";
    if (days <= 0) return "due now";
    const months = days / 30.4375;
    if (months >= 1) return `${formatHours(left.dividedBy(months).toString())}/mo`;
    return `${formatHours(left.toString())} in ${days}d`;
  };

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
  const rowUsedDollars = (r: Row) => dec(r.perHour || 0).times(dec(r.used || 0));
  const grandTotal = rows.reduce((s, r) => s.plus(rowTotal(r)), dec(0));
  const totalAuthorized = rows.reduce((s, r) => s.plus(dec(r.hours || 0)), dec(0));
  const totalUsed = rows.reduce((s, r) => s.plus(dec(r.used || 0)), dec(0));
  // Dollar totals — hours can't be summed across programs (each is priced
  // differently), so the total row talks money, per the sheet's intent.
  const totalUsedDollars = rows.reduce((s, r) => s.plus(rowUsedDollars(r)), dec(0));
  const totalLeftDollars = grandTotal.minus(totalUsedDollars);
  const totalLeftHours = totalAuthorized.minus(totalUsed);
  // Per-month-to-finish, summed per program (each toward its own renewal). Capped
  // at what's actually left: when a program renews in under a month the raw pace
  // exceeds the hours/dollars left, which reads as nonsense — you'd bill the rest
  // within days, not spread over a month.
  const perMonthDollarsTotal = rows.reduce((s, r) => s.plus(perMonthDollarsRow(r) ?? dec(0)), dec(0));
  const perMonthDollars = perMonthDollarsTotal.greaterThan(0)
    ? (totalLeftDollars.greaterThan(0) && perMonthDollarsTotal.greaterThan(totalLeftDollars) ? totalLeftDollars : perMonthDollarsTotal)
    : null;
  const perMonthHoursTotal = rows.reduce((s, r) => s.plus(perMonth(r) ?? dec(0)), dec(0));
  const perMonthHours = perMonthHoursTotal.greaterThan(0)
    ? (totalLeftHours.greaterThan(0) && perMonthHoursTotal.greaterThan(totalLeftHours) ? totalLeftHours : perMonthHoursTotal)
    : null;

  // Over/under budget, counted PER PROGRAM (never netted — one program can be
  // over while another is under, and both matter).
  const statusCounts = rows.reduce<Partial<Record<BudgetLineStatus, number>>>((m, r) => {
    const s = budgetStatusFromHours(Number(r.hours || 0), Number(r.used || 0));
    m[s] = (m[s] ?? 0) + 1;
    return m;
  }, {});

  const setRow = (pid: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.programId === pid ? { ...r, ...patch } : r)));
  const removeRow = (pid: string) => setRows((rs) => rs.filter((r) => r.programId !== pid));
  const addProgram = (pid: string) => {
    const p = programs.find((x) => x.id === pid);
    if (!p) return;
    setRows((rs) => [...rs, { programId: p.id, programName: p.name, perHour: defaultRate.get(p.id) ?? "0", hours: "", used: usedByProgram.get(p.id) ?? "0", daysToRenewal: null, effectiveRenewal: null, calendarYear: isCalendarYearProgram(p.code) }]);
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
        if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save the financial plan.");

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
      setNotice(e instanceof Error ? e.message : "Could not save the financial plan.");
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
            <p className="font-semibold text-[var(--color-ink)]">Projection inputs by program</p>
            <p className="text-xs text-[var(--color-ink-faint)]">
              Financial target period ends {effectiveRenewal ?? "—"}
              {activeInitial ? "" : " · account inactive (projection date is not auto-rolling)"}.
            </p>
            <p className="mt-1 text-xs text-[var(--color-ink-faint)]">Projection only. Service authorization hours are managed in Budget.</p>
            {rows.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5" title="Counted per program — one program can be over while another is under.">
                {(["over", "almost", "on_track", "unused"] as BudgetLineStatus[])
                  .filter((s) => statusCounts[s])
                  .map((s) => (
                    <span key={s} className="badge" style={{ background: BUDGET_STATUS_PRESENT[s].tint, color: BUDGET_STATUS_PRESENT[s].color }}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: BUDGET_STATUS_PRESENT[s].color }} />
                      {statusCounts[s]} {BUDGET_STATUS_PRESENT[s].label.toLowerCase()}
                    </span>
                  ))}
              </div>
            ) : null}
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
              <button type="button" onClick={startEdit} className="btn btn-sm btn-secondary">Edit financial plan</button>
            ) : null}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="px-5 py-6 text-sm text-[var(--color-ink-soft)]">
            No projection inputs yet.{canEdit ? " Click “Edit financial plan” to add the first one." : ""}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[var(--color-text-soft)]">
                  <th className="px-5 py-2 font-medium">Program</th>
                  {canSeeMoney ? <th className="px-3 py-2 text-right font-medium">Per hour</th> : null}
                  <th className="px-3 py-2 text-right font-medium">Target hours</th>
                  {canSeeMoney ? <th className="px-3 py-2 text-right font-medium">Total</th> : null}
                  <th className="px-3 py-2 text-right font-medium">Actual</th>
                  <th className="px-3 py-2 text-right font-medium">Target left</th>
                  <th className="px-3 py-2 text-right font-medium" title="Pace needed to reach this financial target by the projection period end">Target pace</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const left = dec(r.hours || 0).minus(dec(r.used || 0));
                  const status = budgetStatusFromHours(Number(r.hours || 0), Number(r.used || 0));
                  return (
                    <tr key={r.programId} className="border-t border-[var(--color-rule)]">
                      <td className="px-5 py-2 font-medium">
                        <Link className="text-[var(--color-primary)] hover:underline" href={txLink({ individualId, program: r.programName, pbFrom: periodStart ?? undefined, pbTo: periodEnd ?? undefined })}>{r.programName}</Link>
                        {r.calendarYear ? (
                          <span className="ml-2 rounded bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-[0.7rem] font-medium text-[var(--color-ink-soft)]" title="This program always runs the calendar year, Jan 1 → Jan 1.">Jan–Jan</span>
                        ) : null}
                      </td>
                      {canSeeMoney ? <td className="tnum px-3 py-2 text-right">{formatMoney(r.perHour)}</td> : null}
                      <td className="tnum px-3 py-2 text-right">{formatHours(r.hours)}</td>
                      {canSeeMoney ? <td className="tnum px-3 py-2 text-right font-medium">{formatMoney(rowTotal(r).toString())}</td> : null}
                      <td className="tnum px-3 py-2 text-right">{formatHours(r.used)}</td>
                      <td className="tnum px-3 py-2 text-right" style={{ color: left.isNegative() ? "var(--color-pace-over)" : undefined }}>{formatHours(left.toString())}</td>
                      <td className="tnum px-3 py-2 text-right text-[var(--color-ink-soft)]" title={r.effectiveRenewal ? `Renews ${r.effectiveRenewal}` : undefined}>{finishLabel(left, r.daysToRenewal)}</td>
                      <td className="px-5 py-2"><StatusPill status={status} /></td>
                    </tr>
                  );
                })}
                {canSeeMoney ? (
                <tr className="border-t-2 border-[var(--color-rule-strong)] font-semibold">
                  <td className="px-5 py-2">Total <span className="text-xs font-normal text-[var(--color-ink-faint)]">(in $)</span></td>
                  <td></td>
                  <td className="tnum px-3 py-2 text-right text-xs font-normal text-[var(--color-ink-faint)]">{formatHours(totalAuthorized.toString())} h</td>
                  <td className="tnum px-3 py-2 text-right">{formatMoney(grandTotal.toString())}</td>
                  <td className="tnum px-3 py-2 text-right">{formatMoney(totalUsedDollars.toString())}</td>
                  <td className="tnum px-3 py-2 text-right" style={{ color: totalLeftDollars.isNegative() ? "var(--color-pace-over)" : undefined }}>{formatMoney(totalLeftDollars.toString())}</td>
                  <td className="tnum px-3 py-2 text-right">{perMonthDollars ? `${formatMoney(perMonthDollars.toString())}/mo` : "—"}</td>
                  <td></td>
                </tr>
                ) : (
                <tr className="border-t-2 border-[var(--color-rule-strong)] font-semibold">
                  <td className="px-5 py-2">Total <span className="text-xs font-normal text-[var(--color-ink-faint)]">(hours)</span></td>
                  <td className="tnum px-3 py-2 text-right">{formatHours(totalAuthorized.toString())}</td>
                  <td className="tnum px-3 py-2 text-right">{formatHours(totalUsed.toString())}</td>
                  <td className="tnum px-3 py-2 text-right" style={{ color: totalAuthorized.minus(totalUsed).isNegative() ? "var(--color-pace-over)" : undefined }}>{formatHours(totalAuthorized.minus(totalUsed).toString())}</td>
                  <td className="tnum px-3 py-2 text-right">{perMonthHours ? `${formatHours(perMonthHours.toString())}/mo` : "—"}</td>
                  <td></td>
                </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-[var(--color-rule)] px-5 py-2 text-xs text-[var(--color-ink-faint)]">
          {canSeeMoney
            ? "Each program is shown in hours; the total is in dollars because hours aren’t comparable across programs (each bills at a different rate)."
            : "Each program is shown in hours."}
          {canEdit && billedNotInPlan.length > 0
            ? ` Billed in this projection period but not in the financial plan: ${billedNotInPlan.map((l) => `${l.programName} (${formatHours(l.usedHours)} h)`).join(", ")}. Edit the financial plan to add them.`
            : ""}
        </p>
      </div>
    );
  }

  /* ---------------------------------------------------------------- editing */
  return (
    <div className="card mb-6 border-[var(--color-primary-soft)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-rule)] bg-[var(--color-primary-tint)] px-5 py-3">
        <div>
          <p className="font-semibold text-[var(--color-ink)]">Editing financial projection inputs</p>
          <p className="text-xs text-[var(--color-ink-faint)]">These values do not change service authorizations.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={cancel} disabled={busy} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="button" onClick={save} disabled={busy} className="btn btn-sm btn-primary">{busy ? "Saving…" : "Save financial plan"}</button>
        </div>
      </div>

      {notice ? <p className="border-b border-[var(--color-rule)] bg-[var(--color-danger-soft)] px-5 py-2 text-sm text-[var(--color-danger)]">{notice}</p> : null}

      {/* Renewal + active */}
      <div className="grid gap-4 border-b border-[var(--color-rule)] px-5 py-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Projection period end</span>
          <input type="date" value={renewal} onChange={(e) => setRenewal(e.target.value)} className="input mt-1 w-full" />
          <span className="mt-1 block text-xs text-[var(--color-ink-faint)]">
            This date controls only the financial projection and transaction comparison window. Program authorization periods are managed in Budget.
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="mt-1" />
          <span>
            <span className="font-medium">Account is active</span>
            <span className="mt-1 block text-xs text-[var(--color-ink-faint)]">
              Active accounts auto-roll this projection date forward each year. Uncheck to make the account inactive and freeze the date where it is.
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
              <th className="px-3 py-2 text-right font-medium">Target hours</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 text-right font-medium">Actual</th>
              <th className="px-3 py-2 text-right font-medium">Target left</th>
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
