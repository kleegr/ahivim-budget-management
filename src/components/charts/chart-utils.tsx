import type { ReactNode } from "react";
import { dec, type MoneyInput } from "@/lib/money";

/**
 * Chart primitives — dependency-free, server-rendered SVG.
 *
 * These never fetch or derive an authoritative figure. Money and hours stay as
 * decimal-safe strings for display; `Number` is used ONLY to turn a value into a
 * pixel coordinate. Colour comes from the app's design tokens — the teal/slate
 * brand and the `--color-pace-*` status scale — so a chart reads as part of the
 * same system as the meters and badges around it.
 */

/** Parse a decimal string to a finite number for PIXEL GEOMETRY ONLY. */
export function toNum(v: MoneyInput): number {
  try {
    const n = dec(v).toNumber();
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Clamp a number into a range (geometry helper). */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Format a already-percentage value (e.g. 83.3333, NOT a 0..1 fraction) as a
 * short label. Kept decimal-safe so a long repeating value never leaks in.
 */
export function pct(value: MoneyInput, places = 0): string {
  return `${dec(value).toDecimalPlaces(places).toString()}%`;
}

/** Sum a column of decimal strings, returning a decimal string (never a float). */
export function sumCol(values: Array<string | number | null | undefined>): string {
  let total = dec(0);
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    try {
      total = total.plus(dec(v));
    } catch {
      /* skip an unparseable cell */
    }
  }
  return total.toString();
}

/** The full brand + status token map charts draw from. */
export const CHART_COLORS = {
  primary: "var(--color-primary)",
  accent: "var(--color-accent)",
  good: "var(--color-success)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
  info: "var(--color-info)",
  neutral: "var(--color-ink)",
  muted: "var(--color-ink-faint)",
  // The signature pace scale, used for utilization/status colour.
  behind: "var(--color-pace-behind)",
  on: "var(--color-pace-on)",
  ahead: "var(--color-pace-ahead)",
  near: "var(--color-pace-near)",
  over: "var(--color-pace-over)",
  idle: "var(--color-pace-idle)",
} as const;

export type ChartTone = keyof typeof CHART_COLORS;

export function toneColor(tone: ChartTone | undefined, fallback: ChartTone = "primary"): string {
  return CHART_COLORS[tone ?? fallback] ?? CHART_COLORS[fallback];
}

/** A brand-consistent categorical ramp for multi-category charts. */
export const CATEGORICAL: ChartTone[] = [
  "primary",
  "accent",
  "behind",
  "ahead",
  "info",
  "near",
  "over",
  "muted",
];

export function categoricalColor(i: number): string {
  return CHART_COLORS[CATEGORICAL[i % CATEGORICAL.length]];
}

/** Truncate a category label so the label-free SSR layout stays predictable. */
export function truncate(s: string, max = 20): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface LegendItem {
  label: string;
  value?: string;
  color: string;
}

/** A visible legend that also carries the tabular values as text. */
export function Legend({ items, className = "" }: { items: LegendItem[]; className?: string }) {
  return (
    <ul className={`flex flex-wrap gap-x-4 gap-y-1.5 text-xs ${className}`}>
      {items.map((it, i) => (
        <li key={i} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ background: it.color }}
          />
          <span className="text-[var(--color-ink-soft)]">{it.label}</span>
          {it.value !== undefined ? (
            <span className="tnum font-semibold text-[var(--color-ink)]">{it.value}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Wraps a chart with an optional heading, the SVG, a visible legend, and an
 * sr-only text summary so the figure is fully described without the graphic.
 */
export function ChartFigure({
  title,
  subtitle,
  legend,
  summary,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  legend?: LegendItem[];
  summary: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={`m-0 ${className}`}>
      {title ? (
        <figcaption className="display mb-0.5 text-[0.9rem] font-semibold text-[var(--color-ink)]">
          {title}
        </figcaption>
      ) : null}
      {subtitle ? <p className="mb-2 text-xs text-[var(--color-ink-faint)]">{subtitle}</p> : null}
      <div className="mt-1">{children}</div>
      {legend && legend.length > 0 ? <Legend items={legend} className="mt-3" /> : null}
      <p className="sr-only">{summary}</p>
    </figure>
  );
}
