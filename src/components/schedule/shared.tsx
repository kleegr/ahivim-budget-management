"use client";

import type { ReactNode } from "react";
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
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`mt-6 w-full ${wide ? "max-w-2xl" : "max-w-lg"} rounded-lg border border-[var(--color-rule)] bg-[var(--color-surface)] shadow-xl`}>
        <div className="flex items-center justify-between border-b border-[var(--color-rule)] px-5 py-3">
          <h2 className="display text-base font-medium">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded px-2 py-1 text-sm text-[var(--color-ink-faint)] hover:bg-[var(--color-paper)]">✕</button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * A compact session chip used in the month and week views.
 * ------------------------------------------------------------------------- */
export function SessionChip({ s, onSelect }: { s: CalendarSession; onSelect: (s: CalendarSession) => void }) {
  const who = s.employeeName ?? "Unassigned";
  return (
    <button
      type="button"
      onClick={() => onSelect(s)}
      title={`${prettyTime(s.startTime)} ${s.programName} — ${who}`}
      className={`block w-full truncate rounded border-l-2 px-1 py-0.5 text-left text-[11px] leading-tight ${STATUS_STYLE[s.status] ?? "bg-[var(--color-rule)]"}`}
    >
      {s.startTime ? <span className="tnum mr-1">{prettyTime(s.startTime)}</span> : null}
      {s.programName}
      {s.isGroup ? <span className="ml-1">·{s.groupSize}</span> : null}
      {s.warningCount > 0 ? <span className="ml-1" title={`${s.warningCount} warning(s)`}>⚠</span> : null}
    </button>
  );
}
