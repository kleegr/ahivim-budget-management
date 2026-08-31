import Link from "next/link";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Info,
  Inbox,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { formatMoney, formatHours, dec } from "@/lib/money";
import { friendlyActionError } from "@/lib/nav/review-actions";
import { ReloadButton } from "@/components/ui-client";

/** Shared presentation pieces. Nothing here fetches or derives a figure. */

export function Card({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      {(title || description || action) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5">
          <div className="min-w-0">
            {title ? <h2 className="display text-[0.95rem] font-semibold text-[var(--color-ink)]">{title}</h2> : null}
            {description ? (
              <p className="mt-1 max-w-3xl text-sm text-[var(--color-ink-soft)]">{description}</p>
            ) : null}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

const TONE_COLOR: Record<string, string> = {
  alert: "var(--color-danger)",
  warn: "var(--color-warn)",
  good: "var(--color-success)",
  info: "var(--color-info)",
  neutral: "var(--color-ink)",
};

export type MetricTone = "neutral" | "warn" | "alert" | "good" | "info";

export function Metric({
  label,
  value,
  hint,
  unavailable,
  tone = "neutral",
  href,
  icon,
  comparison,
  className = "",
}: {
  label: string;
  value?: ReactNode;
  hint?: ReactNode;
  unavailable?: string;
  tone?: MetricTone;
  href?: string;
  icon?: ReactNode;
  comparison?: ReactNode;
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="eyebrow min-w-0">{label}</p>
        {icon ? <span className="shrink-0 text-[var(--color-ink-faint)]">{icon}</span> : href ? (
          <ArrowUpRight aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" />
        ) : null}
      </div>
      {unavailable ? (
        <div className="mt-2">
          <p className="text-sm font-semibold text-[var(--color-ink-soft)]">Not available</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-faint)]">{unavailable}</p>
        </div>
      ) : (
        <>
          <p className="tnum mt-2 text-[1.5rem] font-semibold leading-none" style={{ color: TONE_COLOR[tone] }}>
            {value ?? "—"}
          </p>
          {comparison ? <div className="mt-2 text-xs font-medium text-[var(--color-ink-soft)]">{comparison}</div> : null}
          {hint ? <div className="mt-1.5 text-xs leading-relaxed text-[var(--color-ink-faint)]">{hint}</div> : null}
        </>
      )}
    </>
  );

  const classes = `card min-h-[6.75rem] px-4 py-4 ${href ? "card-interactive block" : ""} ${className}`;
  return href ? <Link href={href} className={classes}>{body}</Link> : <div className={classes}>{body}</div>;
}

export function StatTile({
  label,
  value,
  hint,
  unavailable,
  tone = "neutral",
  href,
}: {
  label: string;
  value?: string;
  hint?: string;
  unavailable?: string;
  tone?: MetricTone;
  /** When set, the whole tile is a link (e.g. into the pre-filtered ledger). */
  href?: string;
}) {
  return <Metric label={label} value={value} hint={hint} unavailable={unavailable} tone={tone} href={href} />;
}

export function Money({ value }: { value: string | null | undefined }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-[var(--color-ink-faint)]">—</span>;
  }
  return <span className="tnum">{formatMoney(value)}</span>;
}

export function Hours({ value }: { value: string | null | undefined }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-[var(--color-ink-faint)]">—</span>;
  }
  return <span className="tnum">{formatHours(value)}</span>;
}

export function Plain({ value }: { value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-[var(--color-ink-faint)]">—</span>;
  }
  return <>{value}</>;
}

export function EmptyState({
  title,
  children,
  action,
  icon,
  compact = false,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`px-5 text-center ${compact ? "py-7" : "py-12"}`}>
      <span className="mx-auto grid h-10 w-10 place-items-center rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface-muted)] text-[var(--color-ink-faint)]">
        {icon ?? <Inbox aria-hidden className="h-5 w-5" />}
      </span>
      <h2 className="display mt-3 text-base font-semibold text-[var(--color-ink)]">{title}</h2>
      {children ? (
        <div className="mx-auto mt-1.5 max-w-prose text-sm leading-relaxed text-[var(--color-ink-soft)]">{children}</div>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export type NoticeTone = "info" | "success" | "warning" | "error";

const NOTICE_STYLE: Record<NoticeTone, string> = {
  info: "border-[var(--color-info)] bg-[var(--color-info-soft)] text-[var(--color-info)]",
  success: "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]",
  warning: "border-[var(--color-warn)] bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  error: "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
};

const NOTICE_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  error: AlertCircle,
};

export function Notice({
  tone = "info",
  title,
  children,
  action,
  className = "",
}: {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex flex-wrap items-start gap-3 rounded-lg border border-l-4 px-4 py-3 ${NOTICE_STYLE[tone]} ${className}`}
    >
      <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="text-sm font-semibold text-[var(--color-ink)]">{title}</p> : null}
        {children ? <div className={`${title ? "mt-0.5" : ""} text-sm leading-relaxed text-[var(--color-ink-soft)]`}>{children}</div> : null}
      </div>
      {action ? <div className="w-full pl-7 sm:w-auto sm:shrink-0 sm:pl-0">{action}</div> : null}
    </div>
  );
}

export function ErrorPanel({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const detail = typeof children === "string"
    ? friendlyActionError(children, "This page could not load. Try again.")
    : children;
  return (
    <Notice tone="error" title={title} action={action ?? <ReloadButton />}>
      {detail}
    </Notice>
  );
}

// Semantic → (background, text) using the soft tokens; every badge gets a dot.
const BADGE_TONES: Record<string, "good" | "info" | "warn" | "danger" | "muted"> = {
  valid: "good", committed: "good", confirmed: "good", exact: "good", approved: "good", balanced: "good",
  staged: "info", pending: "info", probable: "info", review: "info",
  needs_review: "warn", open: "warn", requires_review: "warn", hours_mismatch: "warn", amount_mismatch: "warn",
  duplicate: "danger", invalid: "danger", employee_mismatch: "danger", program_mismatch: "danger", rejected: "danger",
  discarded: "muted", not_a_group: "muted", archived: "muted",
};

const TONE_STYLE: Record<string, string> = {
  good: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
  info: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
  warn: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  muted: "bg-[var(--color-surface-strong)] text-[var(--color-ink-soft)]",
};

const STATUS_ICON = {
  good: CheckCircle2,
  info: Info,
  warn: TriangleAlert,
  danger: XCircle,
  muted: CircleDashed,
};

export type StatusTone = keyof typeof STATUS_ICON;

export function StatusBadge({
  tone = "muted",
  label,
  className = "",
}: {
  tone?: StatusTone;
  label: string;
  className?: string;
}) {
  const Icon = STATUS_ICON[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_STYLE[tone]} ${className}`}>
      <Icon aria-hidden className="h-3 w-3 shrink-0" />
      {label}
    </span>
  );
}

export function Badge({ value, label }: { value: string; label?: string }) {
  const tone = BADGE_TONES[value] ?? "muted";
  const text = label ?? value.replace(/_/g, " ");
  return <StatusBadge tone={tone} label={text} />;
}

/** The pace track: fill is hours used, notch is where the calendar has reached. */
export function PaceBar({
  usagePercent,
  timeElapsedPercent,
  color = "var(--color-pace-on)",
}: {
  usagePercent: string;
  timeElapsedPercent: string;
  color?: string;
}) {
  const percent = (v: string) => Math.max(0, dec(v).times(100).toNumber());
  const usedRaw = percent(usagePercent);
  const used = Math.min(100, usedRaw);
  const elapsed = Math.min(100, percent(timeElapsedPercent));
  const overBy = Math.max(0, usedRaw - 100);
  const over = overBy > 0;
  return (
    <div
      role="img"
      aria-label={`${usedRaw.toFixed(1)} percent of authorized hours used; ${elapsed.toFixed(1)} percent of the period elapsed${over ? `; over authorization by ${overBy.toFixed(1)} percent` : ""}`}
    >
      <div className={`pace-track ${over ? "pace-track-over" : ""}`}>
        <div className="pace-fill" style={{ width: `${used}%`, background: over ? "var(--color-danger)" : color }} />
        <div className="pace-notch" style={{ left: `${elapsed}%` }} />
      </div>
      {over ? <p className="pace-overflow-label">Over by {overBy.toFixed(overBy < 10 ? 1 : 0)}%</p> : null}
    </div>
  );
}

export function Table({
  head,
  children,
  caption,
}: {
  head: ReactNode;
  children: ReactNode;
  caption?: string;
}) {
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="min-w-full border-collapse text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-[var(--color-rule)] bg-[var(--color-surface-muted)] text-left">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({
  children,
  numeric,
  scope = "col",
}: {
  children: ReactNode;
  numeric?: boolean;
  scope?: "col" | "row";
}) {
  return (
    <th
      scope={scope}
      className={`px-4 py-2.5 text-xs font-semibold text-[var(--color-ink-soft)] ${
        numeric ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric,
  className = "",
}: {
  children: ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td className={`px-4 py-2.5 align-top ${numeric ? "text-right tnum" : ""} ${className}`}>{children}</td>
  );
}

export function Tr({ children }: { children: ReactNode }) {
  return (
    <tr className="border-b border-[var(--color-rule)] transition-colors last:border-0 hover:bg-[var(--color-surface-muted)]">
      {children}
    </tr>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  meta,
  className = "",
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`mb-7 flex flex-col items-stretch gap-x-6 gap-y-4 border-b border-[var(--color-rule)] pb-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between ${className}`}>
      <div className="min-w-0 flex-1">
        {eyebrow ? <p className="eyebrow text-[var(--color-primary)]">{eyebrow}</p> : null}
        <h1 className="display mt-1 text-[1.75rem] font-semibold leading-tight text-[var(--color-ink)]">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--color-ink-soft)]">{description}</p>
        ) : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-faint)]">{meta}</div> : null}
      </div>
      {action ? <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">{action}</div> : null}
    </header>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  children,
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  variant = "ghost",
  className = "",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
  label: string;
  children: ReactNode;
  variant?: ButtonVariant;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={props.title ?? label}
      className={`btn btn-sm btn-icon btn-${variant} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "secondary",
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
}) {
  return (
    <Link className={`btn btn-sm btn-${variant}`} href={href}>
      {children}
    </Link>
  );
}

export function Pagination({
  basePath,
  total,
  limit,
  offset,
  params = {},
}: {
  basePath: string;
  total: number;
  limit: number;
  offset: number;
  params?: Record<string, string | undefined>;
}) {
  if (total <= limit) return null;
  const build = (nextOffset: number) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
    if (nextOffset > 0) search.set("offset", String(nextOffset));
    const qs = search.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between border-t border-[var(--color-rule)] px-5 py-3 text-sm"
    >
      <p className="tnum text-[var(--color-ink-faint)]">
        {from}–{to} of {total}
      </p>
      <div className="flex gap-2">
        {offset > 0 ? (
          <ButtonLink href={build(Math.max(0, offset - limit))}>
            <ChevronLeft aria-hidden className="h-4 w-4" /> Previous
          </ButtonLink>
        ) : null}
        {to < total ? (
          <ButtonLink href={build(offset + limit)}>
            Next <ChevronRight aria-hidden className="h-4 w-4" />
          </ButtonLink>
        ) : null}
      </div>
    </nav>
  );
}
