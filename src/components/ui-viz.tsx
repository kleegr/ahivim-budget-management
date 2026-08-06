import type { ReactNode } from "react";
import { formatMoney, formatHours, dec } from "@/lib/money";

/**
 * Visualization primitives - meters, headline totals, loading shimmer, and the
 * utilization colour language. Server-safe (no client state); these compose
 * with the existing pieces in ui.tsx. Colour always carries meaning here:
 * money, remaining budget, and pace/risk.
 */

export type VizTone = "primary" | "good" | "warn" | "danger" | "info" | "neutral" | "muted";

const VIZ_TONE: Record<VizTone, string> = {
  primary: "var(--color-primary)",
  good: "var(--color-success)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
  info: "var(--color-info)",
  neutral: "var(--color-ink)",
  muted: "var(--color-ink-faint)",
};

/** Determinate meter. Reuses the pace-track CSS so it matches PaceBar exactly. */
export function ProgressBar({
  percent,
  tone = "primary",
  height = "0.5rem",
  label,
  target,
  showValue = true,
}: {
  percent: number;
  tone?: VizTone;
  height?: string;
  label?: ReactNode;
  target?: number;
  showValue?: boolean;
}) {
  const safe = Number.isFinite(percent) ? percent : 0;
  const width = Math.max(0, Math.min(100, safe));
  return (
    <div>
      {label || showValue ? (
        <div className="mb-1 flex items-center justify-between gap-3 text-xs text-[var(--color-ink-soft)]">
          <span className="truncate">{label}</span>
          {showValue ? <span className="tnum font-semibold">{Math.round(safe)}%</span> : null}
        </div>
      ) : null}
      <div className="pace-track" role="img" aria-label={`${Math.round(safe)} percent`} style={{ height }}>
        <div className="pace-fill" style={{ width: `${width}%`, background: VIZ_TONE[tone] }} />
        {typeof target === "number" ? (
          <div className="pace-notch" style={{ left: `${Math.max(0, Math.min(100, target))}%` }} />
        ) : null}
      </div>
    </div>
  );
}

/** A responsive row of oversized, tone-coloured headline figures. */
export function StatBand({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-4 ${className}`}>{children}</div>;
}

export function BigStat({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: VizTone;
  icon?: ReactNode;
}) {
  return (
    <div className="card px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">{label}</p>
        {icon ? <span className="text-[var(--color-ink-faint)]">{icon}</span> : null}
      </div>
      <p className="tnum mt-2 text-[1.85rem] font-semibold leading-none" style={{ color: VIZ_TONE[tone] }}>
        {value}
      </p>
      {hint ? <p className="mt-2 text-xs text-[var(--color-ink-faint)]">{hint}</p> : null}
    </div>
  );
}

/** Loading shimmer block for skeleton states. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-[var(--color-surface-strong)] ${className}`} />;
}

/** A signed number coloured by direction (gain green, loss red). */
export function DeltaValue({
  value,
  format = "money",
}: {
  value: string | number | null | undefined;
  format?: "money" | "hours" | "plain";
}) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-[var(--color-ink-faint)]">—</span>;
  }
  const n = dec(value).toNumber();
  const color = n > 0 ? "var(--color-success)" : n < 0 ? "var(--color-danger)" : "var(--color-ink-soft)";
  const body = format === "money" ? formatMoney(value) : format === "hours" ? formatHours(value) : String(value);
  return (
    <span className="tnum font-medium" style={{ color }}>
      {n > 0 ? "+" : ""}
      {body}
    </span>
  );
}

/** The utilization status vocabulary (mirrors the business classifier). */
export type UtilizationStatus =
  | "not_started"
  | "behind_pace"
  | "on_pace"
  | "ahead_of_pace"
  | "near_exhaustion"
  | "fully_used"
  | "over_authorization";

const UTIL_COLOR: Record<UtilizationStatus, string> = {
  not_started: "var(--color-pace-idle)",
  behind_pace: "var(--color-pace-behind)",
  on_pace: "var(--color-pace-on)",
  ahead_of_pace: "var(--color-pace-ahead)",
  near_exhaustion: "var(--color-pace-near)",
  fully_used: "var(--color-pace-over)",
  over_authorization: "var(--color-pace-over)",
};

const UTIL_LABEL: Record<UtilizationStatus, string> = {
  not_started: "Not started",
  behind_pace: "Behind pace",
  on_pace: "On pace",
  ahead_of_pace: "Ahead of pace",
  near_exhaustion: "Near exhaustion",
  fully_used: "Fully used",
  over_authorization: "Over budget",
};

export function utilizationColor(status: UtilizationStatus): string {
  return UTIL_COLOR[status] ?? "var(--color-pace-idle)";
}

export function utilizationLabel(status: UtilizationStatus): string {
  return UTIL_LABEL[status] ?? status;
}

/** A coloured pill for a utilization status. */
export function UtilizationBadge({ status }: { status: UtilizationStatus }) {
  const color = utilizationColor(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color, background: "color-mix(in srgb, currentColor 12%, transparent)" }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {utilizationLabel(status)}
    </span>
  );
}
