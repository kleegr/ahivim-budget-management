"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import type { CalendarSession } from "@/lib/data/schedule-queries";

/* ---------------------------------------------------------------------------
 * Types passed from the server page (all serialisable).
 * ------------------------------------------------------------------------- */
export interface Picker {
  id: string;
  label: string;
}
export interface ProgramPicker {
  id: string;
  code: string;
  name: string;
  isGroupCapable: boolean;
}
export type View = "month" | "week" | "day";

/* ---------------------------------------------------------------------------
 * Pure date helpers — everything is string (YYYY-MM-DD) + UTC arithmetic so a
 * browser timezone never shifts a day.
 * ------------------------------------------------------------------------- */
const DAY_MS = 86_400_000;
function parse(d: string): number {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, day ?? 1);
}
function fmt(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
export function addDays(d: string, n: number): string {
  return fmt(parse(d) + n * DAY_MS);
}
export function weekday(d: string): number {
  return new Date(parse(d)).getUTCDay(); // 0=Sun
}
export function startOfWeek(d: string): string {
  return addDays(d, -weekday(d));
}
export function startOfMonth(d: string): string {
  return `${d.slice(0, 7)}-01`;
}
export function monthGridStart(d: string): string {
  return startOfWeek(startOfMonth(d));
}
export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function monthLabel(d: string): string {
  const [y, m] = d.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
export function humanDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return `${WEEKDAYS[weekday(d)]} ${day} ${MONTHS[m - 1]} ${y}`;
}
function minutesOf(t: string | null): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export function durationFromTimes(start: string | null, end: string | null): string {
  const a = minutesOf(start);
  const b = minutesOf(end);
  if (a === null || b === null || b <= a) return "";
  const h = (b - a) / 60;
  return Number.isInteger(h) ? String(h) : h.toFixed(2);
}
export function prettyTime(t: string | null): string {
  return t ? t.slice(0, 5) : "";
}

/* ---------------------------------------------------------------------------
 * API helper — every calendar write goes through this so error handling is
 * uniform.
 * ------------------------------------------------------------------------- */
export async function send(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; data?: unknown };
    if (!res.ok || json.ok === false) return { ok: false, error: json.error ?? `Request failed (${res.status}).` };
    return { ok: true, data: json.data };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

/* ---------------------------------------------------------------------------
 * Status presentation.
 * ------------------------------------------------------------------------- */
export const STATUS_STYLE: Record<string, string> = {
  pending: "bg-[var(--color-primary-soft)] text-[var(--color-primary)] border-[var(--color-primary)]",
  completed: "bg-[#e8f6ee] text-[var(--color-pace-on)] border-[var(--color-pace-on)]",
  cancelled: "bg-[var(--color-rule)] text-[var(--color-ink-faint)] border-[var(--color-rule-strong)] line-through",
  no_show: "bg-[#fdf2f5] text-[var(--color-pace-over)] border-[var(--color-pace-over)]",
};
export const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

/* ---------------------------------------------------------------------------
 * Planning status: colour a session by whether it is on-track, in conflict, or
 * a budget/authorisation risk — reusing the --color-pace-* tokens so the
 * calendar speaks the same colour language as PaceBar / UtilizationBadge.
 * ------------------------------------------------------------------------- */
export interface SessionFlags {
  hasConflict: boolean;
  hasBudgetRisk: boolean;
  warningCount?: number;
}

export type WarningCategory = "conflict" | "budget" | "other";

/**
 * Bucket a stored/preview warning code. Mirrors the server-side sets in
 * data/schedule-queries.ts (listSessionWarningFlags); kept here as a pure
 * client helper so the create-session modal can categorise live preview
 * warnings without importing server code.
 */
export function classifyWarningCode(code: string): WarningCategory {
  switch (code) {
    case "over_authorized_hours":
    case "missing_authorization":
    case "outside_authorization_dates":
      return "budget";
    case "employee_double_booked":
    case "individual_double_booked":
    case "individual_two_employees_one_to_one":
    case "program_not_group":
    case "group_over_max":
      return "conflict";
    default:
      return "other";
  }
}

export type EventTone = "on_track" | "flagged" | "over_risk" | "completed" | "cancelled";

export const EVENT_TONE_COLOR: Record<EventTone, string> = {
  on_track: "var(--color-pace-on)",
  flagged: "var(--color-pace-near)",
  over_risk: "var(--color-pace-over)",
  completed: "var(--color-pace-on)",
  cancelled: "var(--color-pace-idle)",
};

export const EVENT_TONE_LABEL: Record<EventTone, string> = {
  on_track: "On track",
  flagged: "Needs review",
  over_risk: "Over-budget risk",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** The most severe tone that applies to a session, budget risk winning over conflicts. */
export function sessionTone(s: CalendarSession, flags?: SessionFlags): EventTone {
  if (s.status === "cancelled") return "cancelled";
  if (s.status === "no_show") return "over_risk";
  if (flags?.hasBudgetRisk) return "over_risk";
  if (s.warningCount > 0 || flags?.hasConflict) return "flagged";
  if (s.status === "completed") return "completed";
  return "on_track";
}

/* ---------------------------------------------------------------------------
 * Shared modal shell.
 * ------------------------------------------------------------------------- */
export function ModalShell({
  title, onClose, children, wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const initial = panel?.querySelector<HTMLElement>(
        "input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
      ) ?? panel?.querySelector<HTMLElement>("button:not([disabled])");
      initial?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => previousFocus?.focus());
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} className={`mt-6 w-full ${wide ? "max-w-2xl" : "max-w-lg"} rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] shadow-xl`}>
        <div className="flex items-center justify-between border-b border-[var(--color-rule)] px-5 py-3">
          <h2 id={titleId} className="display text-base font-medium">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" title="Close" className="btn btn-icon btn-ghost h-8 w-8"><X aria-hidden className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * A compact session chip used in the month and week views.
 * ------------------------------------------------------------------------- */
export function SessionChip({ s, flags, onSelect }: { s: CalendarSession; flags?: SessionFlags; onSelect: (s: CalendarSession) => void }) {
  const who = s.employeeName ?? "Unassigned";
  const tone = sessionTone(s, flags);
  const color = EVENT_TONE_COLOR[tone];
  const cancelled = tone === "cancelled";
  const toneNote =
    tone === "over_risk" ? (s.status === "no_show" ? "No-show" : "Over-budget / authorisation risk")
    : tone === "flagged" ? `${s.warningCount} warning${s.warningCount === 1 ? "" : "s"}`
    : EVENT_TONE_LABEL[tone];
  return (
    <button
      type="button"
      onClick={() => onSelect(s)}
      title={`${prettyTime(s.startTime)} ${s.programName} — ${who} · ${toneNote}`}
      style={{ borderLeftColor: color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
      className={`block w-full truncate rounded border-l-[3px] px-1 py-0.5 text-left text-[11px] leading-tight text-[var(--color-ink)] ${cancelled ? "line-through opacity-70" : ""}`}
    >
      {s.startTime ? <span className="tnum mr-1">{prettyTime(s.startTime)}</span> : null}
      {s.programName}
      {s.isGroup ? <span className="ml-1">·{s.groupSize}</span> : null}
      {tone === "completed" ? <span className="ml-1" style={{ color }} aria-hidden>✓</span> : null}
      {tone === "over_risk" ? <span className="ml-1 font-bold" style={{ color }} aria-label={toneNote} title={toneNote}>●</span> : null}
      {tone === "flagged" ? <span className="ml-1 font-bold" style={{ color }} aria-label={toneNote} title={toneNote}>▲</span> : null}
    </button>
  );
}
