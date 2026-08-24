"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
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
type ConcretePeriodRange = Exclude<PeriodRange, null>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate(); // m = 1..12

function monthRange(y: number, m: number): ConcretePeriodRange {
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

function sameRange(a: PeriodRange, b: PeriodRange): boolean {
  if (a === null || b === null) return a === b;
  return a.from === b.from && a.to === b.to;
}

function currentPresetRanges(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const quarterStart = Math.floor(now.getMonth() / 3) * 3 + 1;
  return {
    month: monthRange(year, month),
    quarter: { from: iso(year, quarterStart, 1), to: iso(year, quarterStart + 2, lastDay(year, quarterStart + 2)) },
    year: { from: `${year}-01-01`, to: `${year}-12-31` },
  } satisfies Record<"month" | "quarter" | "year", ConcretePeriodRange>;
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
  const [presets, setPresets] = useState<ReturnType<typeof currentPresetRanges> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setPresets(currentPresetRanges());
  }, []);

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

  useEffect(() => {
    const onPopState = () => setRange(parseParam(new URL(window.location.href).searchParams.get(paramKey)));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [paramKey]);

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
    setRange(presets?.month ?? currentPresetRanges().month);
  };
  const thisQuarter = () => {
    setRange(presets?.quarter ?? currentPresetRanges().quarter);
  };
  const thisYear = () => {
    setRange(presets?.year ?? currentPresetRanges().year);
  };

  const preset = (active: boolean) => `btn btn-sm ${active ? "btn-primary" : "btn-secondary"}`;
  const isAll = range === null;
  const isMonth = !!presets && sameRange(range, presets.month);
  const isQuarter = !!presets && sameRange(range, presets.quarter);
  const isYear = !!presets && sameRange(range, presets.year);

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Reporting period">
      <div className="inline-flex items-center overflow-hidden rounded-md border border-[var(--color-rule-strong)] bg-[var(--color-surface)]">
        <button type="button" onClick={() => step(-1)} className="btn btn-sm btn-icon btn-ghost rounded-none border-r border-[var(--color-rule)]" aria-label="Previous month" title="Previous month">
          <ChevronLeft aria-hidden className="h-4 w-4" />
        </button>
        <span className="inline-flex min-h-9 min-w-[8.5rem] items-center justify-center gap-2 px-3 text-center text-sm font-semibold tabular-nums" aria-live="polite">
          <CalendarDays aria-hidden className="h-4 w-4 text-[var(--color-ink-faint)]" />
          {labelOf(range)}
        </span>
        <button type="button" onClick={() => step(1)} className="btn btn-sm btn-icon btn-ghost rounded-none border-l border-[var(--color-rule)]" aria-label="Next month" title="Next month">
          <ChevronRight aria-hidden className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Period presets">
        <button type="button" onClick={thisMonth} aria-pressed={isMonth} className={preset(isMonth)}>This month</button>
        <button type="button" onClick={thisQuarter} aria-pressed={isQuarter} className={preset(isQuarter)}>This quarter</button>
        <button type="button" onClick={thisYear} aria-pressed={isYear} className={preset(isYear)}>This year</button>
        <button type="button" onClick={() => setRange(null)} aria-pressed={isAll} className={preset(isAll)}>All time</button>
      </div>
    </div>
  );
}
