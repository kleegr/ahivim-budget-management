"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The persistent period control — the single most-missed Google-Sheets reflex.
 * A month stepper plus one-tap presets (This month / quarter / year / All time)
 * that sits at the top of a date-driven screen and drives its date filter.
 *
 * It owns a { from, to } range (inclusive ISO dates) or null ("all time"),
 * mirrors the choice into a URL search param so the view is linkable and
 * survives a refresh, and hands the range to the parent via onChange. To stay
 * hydration-safe it never calls `new Date()` during the first render — the
 * initial value comes only from the URL; today-relative presets are computed in
 * click handlers, which run on the client after mount.
 */

export type PeriodRange = { from: string; to: string } | null;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate(); // m = 1..12

function monthRange(y: number, m: number): PeriodRange {
  return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) };
}
function monthOf(r: PeriodRange): { y: number; m: number } | null {
  if (!r) return null;
  const mm = r.from.match(/^(\d{4})-(\d{2})-01$/);
  if (!mm) return null;
  const y = Number(mm[1]);
  const m = Number(mm[2]);
  return r.to === iso(y, m, lastDay(y, m)) ? { y, m } : null;
}
function labelOf(r: PeriodRange): string {
  if (!r) return "All time";
  const mo = monthOf(r);
  if (mo) return `${MONTHS[mo.m - 1]} ${mo.y}`;
  if (/^\d{4}-01-01$/.test(r.from) && /^\d{4}-12-31$/.test(r.to) && r.from.slice(0, 4) === r.to.slice(0, 4)) return r.from.slice(0, 4);
  return `${r.from} → ${r.to}`;
}
function parseParam(v: string | null): PeriodRange {
  if (!v || v === "all") return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  return m ? { from: m[1], to: m[2] } : null;
}

export default function PeriodControl({
  onChange,
  paramKey = "period",
}: {
  onChange: (range: PeriodRange) => void;
  paramKey?: string;
}) {
  const initial = useMemo<PeriodRange>(() => {
    if (typeof window === "undefined") return null;
    return parseParam(new URLSearchParams(window.location.search).get(paramKey));
  }, [paramKey]);

  const [range, setRange] = useState<PeriodRange>(initial);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Apply on mount and whenever the range changes; keep the URL in sync without a
  // server round-trip. Depends only on `range` (onChange is read via a ref so an
  // unstable parent callback can't cause a loop).
  useEffect(() => {
    onChangeRef.current(range);
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      if (range) u.searchParams.set(paramKey, `${range.from}..${range.to}`);
      else u.searchParams.delete(paramKey);
      window.history.replaceState(null, "", u.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const step = (delta: number) => {
    const base = monthOf(range) ?? (() => {
      const d = new Date();
      return { y: d.getFullYear(), m: d.getMonth() + 1 };
    })();
    let y = base.y;
    let m = base.m + delta;
    while (m < 1) {
      m += 12;
      y -= 1;
    }
    while (m > 12) {
      m -= 12;
      y += 1;
    }
    setRange(monthRange(y, m));
  };
  const thisMonth = () => {
    const d = new Date();
    setRange(monthRange(d.getFullYear(), d.getMonth() + 1));
  };
  const thisQuarter = () => {
    const d = new Date();
    const y = d.getFullYear();
    const startM = Math.floor(d.getMonth() / 3) * 3 + 1;
    setRange({ from: iso(y, startM, 1), to: iso(y, startM + 2, lastDay(y, startM + 2)) });
  };
  const thisYear = () => {
    const y = new Date().getFullYear();
    setRange({ from: `${y}-01-01`, to: `${y}-12-31` });
  };

  const btn = "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors";
  const preset = (active: boolean) =>
    `${btn} ${active ? "bg-[var(--color-primary)] text-white" : "border border-[var(--color-rule-strong)] bg-[var(--color-surface)] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"}`;
  const isAll = range === null;
  const isYear = !!range && /^\d{4}-01-01$/.test(range.from) && /^\d{4}-12-31$/.test(range.to);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="inline-flex items-center overflow-hidden rounded-md border border-[var(--color-rule-strong)] bg-[var(--color-surface)]">
        <button type="button" onClick={() => step(-1)} className="px-2 py-1.5 text-sm hover:bg-[var(--color-surface-strong)]" aria-label="Previous month">◀</button>
        <span className="min-w-[7.5rem] px-3 py-1.5 text-center text-sm font-semibold tabular-nums">{labelOf(range)}</span>
        <button type="button" onClick={() => step(1)} className="px-2 py-1.5 text-sm hover:bg-[var(--color-surface-strong)]" aria-label="Next month">▶</button>
      </div>
      <button type="button" onClick={thisMonth} className={preset(false)}>This month</button>
      <button type="button" onClick={thisQuarter} className={preset(false)}>Quarter</button>
      <button type="button" onClick={thisYear} className={preset(isYear)}>Year</button>
      <button type="button" onClick={() => setRange(null)} className={preset(isAll)}>All time</button>
    </div>
  );
}
