import type { CalendarSession, SessionWarningFlags } from "@/lib/data/schedule-queries";
import { listSessions, listSessionWarningFlags } from "@/lib/data/schedule-queries";
import type { PgLikePool } from "@/lib/import/commit";

const ATTENTION_WINDOW_DAYS = 30;

export interface OwnerScheduleAttentionVisit {
  id: string;
  sessionDate: string;
  startTime: string | null;
  employeeName: string | null;
  individualNames: string[];
  programName: string;
  href: string;
}

export interface OwnerScheduleAttention {
  from: string;
  through: string;
  unassignedCount: number;
  conflictCount: number;
  nextUnassigned: OwnerScheduleAttentionVisit | null;
  nextConflict: OwnerScheduleAttentionVisit | null;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function visitHref(session: CalendarSession): string {
  const params = new URLSearchParams({
    view: "calendar",
    date: session.sessionDate,
    calendarView: "day",
    sessionId: session.id,
  });
  return `/schedule?${params.toString()}`;
}

function visit(session: CalendarSession): OwnerScheduleAttentionVisit {
  return {
    id: session.id,
    sessionDate: session.sessionDate,
    startTime: session.startTime,
    employeeName: session.employeeName,
    individualNames: session.individualNames,
    programName: session.programName,
    href: visitHref(session),
  };
}

/**
 * Convert the canonical calendar and live-warning projections into the two
 * schedule signals the owner must act on first. Each signal keeps the exact
 * next visit so Home never drops the owner into an unfiltered calendar.
 */
export function buildOwnerScheduleAttention(input: {
  from: string;
  through: string;
  sessions: CalendarSession[];
  warningFlags: SessionWarningFlags[];
}): OwnerScheduleAttention {
  const flags = new Map(input.warningFlags.map((row) => [row.id, row]));
  const pending = input.sessions.filter((session) => session.status === "pending");
  const unassigned = pending.filter((session) => session.employeeId === null);
  const conflicts = pending.filter((session) => flags.get(session.id)?.hasConflict === true);

  return {
    from: input.from,
    through: input.through,
    unassignedCount: unassigned.length,
    conflictCount: conflicts.length,
    nextUnassigned: unassigned[0] ? visit(unassigned[0]) : null,
    nextConflict: conflicts[0] ? visit(conflicts[0]) : null,
  };
}

/** Upcoming schedule attention only; completed and historical visits stay out. */
export async function getOwnerScheduleAttention(
  pool: PgLikePool,
  from: string,
): Promise<OwnerScheduleAttention> {
  const through = addDays(from, ATTENTION_WINDOW_DAYS);
  const filter = { from, to: through, status: "pending" } as const;
  const [sessions, warningFlags] = await Promise.all([
    listSessions(pool, filter),
    listSessionWarningFlags(pool, filter),
  ]);
  return buildOwnerScheduleAttention({ from, through, sessions, warningFlags });
}
