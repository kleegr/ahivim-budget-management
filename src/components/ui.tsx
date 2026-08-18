import Link from "next/link";
import type { ReactNode } from "react";
import { formatMoney, formatHours, dec } from "@/lib/money";

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
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3.5">
          <div>
            {title ? <h2 className="display text-[0.95rem] font-semibold text-[var(--color-ink)]">{title}</h2> : null}
            {description ? (
              <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">{description}</p>
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
  neutral: "var(--color-ink)",
};

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
  tone?: "neutral" | "warn" | "alert" | "good";
  /** When set, the whole tile is a link (e.g. into the pre-filtered ledger). */
  href?: string;
}) {
  const body = (
    <>
      <p className="eyebrow">{label}</p>
      {unavailable ? (
        <>
          <p className="mt-1.5 text-sm font-medium text-[var(--color-ink-faint)]">Not available</p>
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{unavailable}</p>
        </>
      ) : (
        <>
          <p className="tnum mt-1 text-[1.35rem] font-semibold leading-tight" style={{ color: TONE_COLOR[tone] }}>
            {value}
          </p>
          {hint ? <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{hint}</p> : null}
        </>
      )}
    </>
  );
  if (href) {
    return (
      <Link href={href} className="card block px-4 py-3.5 transition hover:border-[var(--color-primary)] hover:shadow-md">
        {body}
      </Link>
    );
  }
  return <div className="card px-4 py-3.5 transition hover:shadow-md">{body}</div>;
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
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="px-5 py-12 text-center">
      <p className="display text-[0.95rem] font-semibold">{title}</p>
      {children ? (
        <div className="mx-auto mt-1.5 max-w-prose text-sm text-[var(--color-ink-soft)]">{children}</div>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorPanel({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-[var(--color-rule)] border-l-4 border-l-[var(--color-danger)] bg-[var(--color-danger-soft)] px-5 py-4"
    >
      <p className="text-sm font-semibold text-[var(--color-danger)]">{title}</p>
      {children ? <div className="mt-1 text-sm text-[var(--color-ink-soft)]">{children}</div> : null}
    </div>
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

export function Badge({ value, label }: { value: string; label?: string }) {
  const tone = BADGE_TONES[value] ?? "muted";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${TONE_STYLE[tone]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {label ?? value.replace(/_/g, " ")}
    </span>
  );
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
  const clamp = (v: string) => Math.max(0, Math.min(100, dec(v).times(100).toNumber()));
  const used = clamp(usagePercent);
  const elapsed = clamp(timeElapsedPercent);
  return (
    <div
      className="pace-track"
      role="img"
      aria-label={`${used.toFixed(1)} percent of authorized hours used; ${elapsed.toFixed(1)} percent of the period elapsed`}
    >
      <div className="pace-fill" style={{ width: `${used}%`, background: color }} />
      <div className="pace-notch" style={{ left: `${elapsed}%` }} />
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
      <table className="w-full border-collapse text-sm">
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
      className={`px-4 py-2.5 text-[0.6875rem] font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase ${
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
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className="display mt-1 text-[1.6rem] font-semibold leading-tight">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-sm text-[var(--color-ink-soft)]">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "secondary",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
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
        {offset > 0 ? <ButtonLink href={build(Math.max(0, offset - limit))}>Previous</ButtonLink> : null}
        {to < total ? <ButtonLink href={build(offset + limit)}>Next</ButtonLink> : null}
      </div>
    </nav>
  );
}
