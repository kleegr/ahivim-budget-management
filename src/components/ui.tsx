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
    <section
      className={`rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] ${className}`}
    >
      {(title || action) && (
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-rule)] px-5 py-3">
          <div>
            {title ? <h2 className="display text-base font-medium">{title}</h2> : null}
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

export function StatTile({
  label,
  value,
  hint,
  unavailable,
  tone = "neutral",
}: {
  label: string;
  value?: string;
  hint?: string;
  unavailable?: string;
  tone?: "neutral" | "warn" | "alert" | "good";
}) {
  const toneColor =
    tone === "alert"
      ? "var(--color-pace-over)"
      : tone === "warn"
        ? "var(--color-pace-near)"
        : tone === "good"
          ? "var(--color-pace-on)"
          : "var(--color-ink)";
  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3">
      <p className="eyebrow">{label}</p>
      {unavailable ? (
        <>
          <p className="mt-1 text-sm font-medium text-[var(--color-ink-faint)]">Not available</p>
          <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{unavailable}</p>
        </>
      ) : (
        <>
          <p className="tnum mt-1 text-xl font-semibold" style={{ color: toneColor }}>
            {value}
          </p>
          {hint ? <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{hint}</p> : null}
        </>
      )}
    </div>
  );
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
    <div className="px-5 py-10 text-center">
      <p className="display text-sm font-medium">{title}</p>
      {children ? (
        <div className="mx-auto mt-2 max-w-prose text-sm text-[var(--color-ink-soft)]">
          {children}
        </div>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorPanel({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-[var(--color-pace-over)] bg-[#fdf2f5] px-5 py-4"
    >
      <p className="text-sm font-medium text-[var(--color-pace-over)]">{title}</p>
      {children ? (
        <div className="mt-1 text-sm text-[var(--color-ink-soft)]">{children}</div>
      ) : null}
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  valid: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
  committed: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
  staged: "bg-[#eef2ff] text-[var(--color-pace-behind)]",
  pending: "bg-[#eef2ff] text-[var(--color-pace-behind)]",
  needs_review: "bg-[#fff4ed] text-[var(--color-pace-near)]",
  duplicate: "bg-[#fdf2f5] text-[var(--color-pace-over)]",
  invalid: "bg-[#fdf2f5] text-[var(--color-pace-over)]",
  discarded: "bg-[var(--color-rule)] text-[var(--color-ink-soft)]",
  open: "bg-[#fff4ed] text-[var(--color-pace-near)]",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  const tone = BADGE_TONES[value] ?? "bg-[var(--color-rule)] text-[var(--color-ink-soft)]";
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${tone}`}>
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
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-[var(--color-rule)] text-left">{head}</tr>
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
      className={`px-4 py-2 text-xs font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase ${
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
    <td className={`px-4 py-2 align-top ${numeric ? "text-right" : ""} ${className}`}>{children}</td>
  );
}

export function Tr({ children }: { children: ReactNode }) {
  return <tr className="border-b border-[var(--color-rule)] last:border-0">{children}</tr>;
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
        <h1 className="display mt-0.5 text-2xl font-medium">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-soft)]">{description}</p>
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
  variant?: "primary" | "secondary";
}) {
  const style =
    variant === "primary"
      ? "bg-[var(--color-primary)] text-white"
      : "border border-[var(--color-rule-strong)] bg-white text-[var(--color-ink)]";
  return (
    <Link className={`inline-block rounded px-3 py-1.5 text-sm font-medium ${style}`} href={href}>
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
          <ButtonLink href={build(Math.max(0, offset - limit))}>Previous</ButtonLink>
        ) : null}
        {to < total ? <ButtonLink href={build(offset + limit)}>Next</ButtonLink> : null}
      </div>
    </nav>
  );
}
