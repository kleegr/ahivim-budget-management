"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { dec, formatMoney } from "@/lib/money";

/**
 * The financial cuts, editable right on the profile — the same shape and feel as
 * the budget editor. The plan's money is the budget priced out (yearly gross),
 * taken to a month, then the two cuts and the clock / other adjustments to a net.
 * Cuts are set here inline (no jump to the Financial sheet); the net previews as
 * you type. The renewal date is the budget's renewal — one and the same plan.
 */

const clean = (s: string) => {
  try { return dec(s || "0").toString(); } catch { return "0"; }
};
const pctToFraction = (s: string) => {
  const d = dec(clean(s));
  return d.abs().greaterThan(1) ? d.dividedBy(100) : d;
};

export default function CutsEditor({
  strategyId,
  yearlyGross,
  cut1Percent,
  cut2Percent,
  monthDivisor,
  clockAdjustment,
  otherAdjustment,
  afterAll,
  canManage,
}: {
  strategyId: string | null;
  yearlyGross: string; // Σ authorized × rate (internal), the plan's top line
  cut1Percent: string; // stored fraction, e.g. "0.24"
  cut2Percent: string;
  monthDivisor: string;
  clockAdjustment: string;
  otherAdjustment: string;
  afterAll: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Inputs are shown as PERCENT (24), stored as fraction (0.24).
  const [cut1, setCut1] = useState(dec(cut1Percent || 0).times(100).toString());
  const [cut2, setCut2] = useState(dec(cut2Percent || 0).times(100).toString());
  const [divisor, setDivisor] = useState(monthDivisor || "12");
  const [clock, setClock] = useState(clockAdjustment || "0");
  const [other, setOther] = useState(otherAdjustment || "0");
  const [after, setAfter] = useState(afterAll ?? "");

  const reset = () => {
    setCut1(dec(cut1Percent || 0).times(100).toString());
    setCut2(dec(cut2Percent || 0).times(100).toString());
    setDivisor(monthDivisor || "12");
    setClock(clockAdjustment || "0");
    setOther(otherAdjustment || "0");
    setAfter(afterAll ?? "");
    setNotice(null);
  };

  // Live math (mirrors computeStrategy): gross ÷ months, cut1 on the month, cut2
  // on the balance, then the signed adjustments.
  const src = editing
    ? { c1: pctToFraction(cut1), c2: pctToFraction(cut2), div: dec(clean(divisor)).greaterThan(0) ? dec(clean(divisor)) : dec(12), clk: dec(clean(clock)), oth: dec(clean(other)) }
    : { c1: dec(cut1Percent || 0), c2: dec(cut2Percent || 0), div: dec(monthDivisor || 12).greaterThan(0) ? dec(monthDivisor || 12) : dec(12), clk: dec(clockAdjustment || 0), oth: dec(otherAdjustment || 0) };
  const gross = dec(yearlyGross || 0);
  const monthly = gross.dividedBy(src.div);
  const cut1Amt = monthly.times(src.c1);
  const afterCut1 = monthly.minus(cut1Amt);
  const cut2Amt = afterCut1.times(src.c2);
  const grossNet = afterCut1.minus(cut2Amt);
  const net = grossNet.plus(src.clk).plus(src.oth);

  const pctLabel = (frac: ReturnType<typeof dec>) => `${frac.times(100).toDecimalPlaces(2)}%`;
  const money = (d: ReturnType<typeof dec>) => formatMoney(d.toString());

  const save = async () => {
    if (!strategyId) { setNotice("Add the budget first, then set the cuts."); return; }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/calculation-strategies/${strategyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cut1Percent: clean(cut1),
          cut2Percent: clean(cut2),
          monthDivisor: clean(divisor),
          clockAdjustment: clean(clock),
          otherAdjustment: clean(other),
          afterAll: after.trim() === "" ? null : clean(after),
        }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save the cuts.");
      setEditing(false);
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not save the cuts.");
    } finally {
      setBusy(false);
    }
  };

  const Line = ({ label, value, sub, strong, minus }: { label: string; value: string; sub?: string; strong?: boolean; minus?: boolean }) => (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--color-rule)] py-1.5 last:border-0">
      <div><span className={strong ? "font-semibold" : ""}>{label}</span>{sub ? <span className="ml-2 text-xs text-[var(--color-ink-faint)]">{sub}</span> : null}</div>
      <span className={`tnum ${strong ? "text-base font-semibold" : ""} ${minus ? "text-[var(--color-danger)]" : ""}`}>{value}</span>
    </div>
  );

  if (!editing) {
    return (
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-soft)]">How the plan is priced (company)</p>
          {canManage ? (
            <button type="button" onClick={() => { reset(); setEditing(true); }} className="btn btn-sm btn-secondary">Edit cuts</button>
          ) : null}
        </div>
        <Line label="Yearly gross" value={money(gross)} sub="authorized hours × rate" />
        <Line label="Monthly gross" value={money(monthly)} sub={`÷ ${src.div.toDecimalPlaces(2)} months`} />
        <Line label={`First cut (${pctLabel(src.c1)})`} value={`− ${money(cut1Amt)} /mo`} minus />
        <Line label={`Second cut (${pctLabel(src.c2)})`} value={`− ${money(cut2Amt)} /mo`} sub="on the balance after the first cut" minus />
        {src.clk.isZero() ? null : <Line label="Clock adjustment" value={`${src.clk.isNegative() ? "−" : "+"} ${money(src.clk.abs())} /mo`} />}
        {src.oth.isZero() ? null : <Line label="Other adjustment" value={`${src.oth.isNegative() ? "−" : "+"} ${money(src.oth.abs())} /mo`} />}
        <Line label="Net per month" value={money(net)} strong />
        {afterAll ? <Line label="Final (“after all”)" value={money(dec(afterAll))} sub="the workbook's final figure" strong /> : null}
        {notice ? <p className="mt-2 text-sm text-[var(--color-danger)]">{notice}</p> : null}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--color-primary-soft)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-semibold text-[var(--color-ink)]">Editing the cuts</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => { reset(); setEditing(false); }} disabled={busy} className="btn btn-sm btn-ghost">Cancel</button>
          <button type="button" onClick={save} disabled={busy} className="btn btn-sm btn-primary">{busy ? "Saving…" : "Save cuts"}</button>
        </div>
      </div>
      {notice ? <p className="mb-2 text-sm text-[var(--color-danger)]">{notice}</p> : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="block text-sm"><span className="text-xs text-[var(--color-ink-soft)]">First cut %</span>
          <input type="number" step="any" value={cut1} onChange={(e) => setCut1(e.target.value)} className="input mt-1 w-full text-right tabular-nums" /></label>
        <label className="block text-sm"><span className="text-xs text-[var(--color-ink-soft)]">Second cut %</span>
          <input type="number" step="any" value={cut2} onChange={(e) => setCut2(e.target.value)} className="input mt-1 w-full text-right tabular-nums" /></label>
        <label className="block text-sm"><span className="text-xs text-[var(--color-ink-soft)]">Months (÷)</span>
          <input type="number" step="any" value={divisor} onChange={(e) => setDivisor(e.target.value)} className="input mt-1 w-full text-right tabular-nums" /></label>
        <label className="block text-sm"><span className="text-xs text-[var(--color-ink-soft)]">Clock adj $/mo</span>
          <input type="number" step="any" value={clock} onChange={(e) => setClock(e.target.value)} className="input mt-1 w-full text-right tabular-nums" /></label>
        <label className="block text-sm"><span className="text-xs text-[var(--color-ink-soft)]">Other adj $/mo</span>
          <input type="number" step="any" value={other} onChange={(e) => setOther(e.target.value)} className="input mt-1 w-full text-right tabular-nums" /></label>
        <label className="block text-sm"><span className="text-xs text-[var(--color-ink-soft)]">After-all $ (optional)</span>
          <input type="number" step="any" value={after} onChange={(e) => setAfter(e.target.value)} placeholder="—" className="input mt-1 w-full text-right tabular-nums" /></label>
      </div>
      <div className="mt-3 rounded bg-[var(--color-surface-muted)] px-3 py-2 text-sm">
        <div className="flex items-baseline justify-between"><span className="text-[var(--color-ink-soft)]">Preview — monthly gross {money(monthly)} → net</span><span className="tnum text-lg font-semibold">{money(net)}/mo</span></div>
      </div>
    </div>
  );
}
