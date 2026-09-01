import { agencyDate } from "@/lib/business/agency-time";
import { listSessions, type CalendarSession } from "@/lib/data/schedule-queries";
import type { PgLikePool } from "@/lib/import/commit";
import { toHours } from "@/lib/money";

const UPCOMING_SCHEDULE_DAYS = 60;

interface PortalUpcomingAssignmentBase {
  sessionDate: string;
  startTime: string | null;
  endTime: string | null;
  durationHours: string;
  programName: string;
  isGroup: boolean;
}

export interface PortalIndividualUpcomingAssignment extends PortalUpcomingAssignmentBase {
  audience: "individual";
}

export interface PortalEmployeeUpcomingAssignment extends PortalUpcomingAssignmentBase {
  audience: "employee";
  individualNames: string[];
}

export type PortalUpcomingAssignment =
  | PortalIndividualUpcomingAssignment
  | PortalEmployeeUpcomingAssignment;

export interface PortalUpcomingSchedule {
  status: "ready" | "unavailable";
  from: string;
  through: string;
  items: PortalUpcomingAssignment[];
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function baseAssignment(session: CalendarSession): PortalUpcomingAssignmentBase {
  return {
    sessionDate: session.sessionDate,
    startTime: session.startTime,
    endTime: session.endTime,
    durationHours: toHours(session.durationHours),
    programName: session.programName,
    isGroup: session.isGroup,
  };
}

export function individualPortalAssignment(session: CalendarSession): PortalIndividualUpcomingAssignment {
  return {
    ...baseAssignment(session),
    audience: "individual",
  };
}

export function employeePortalAssignment(session: CalendarSession): PortalEmployeeUpcomingAssignment {
  return {
    ...baseAssignment(session),
    audience: "employee",
    individualNames: session.individualNames,
  };
}

async function upcomingSchedule(
  pool: PgLikePool,
  filter: { individualId?: string; employeeId?: string },
  audience: "individual" | "employee",
  from = agencyDate(),
): Promise<PortalUpcomingSchedule> {
  const through = addDays(from, UPCOMING_SCHEDULE_DAYS);
  try {
    const sessions = await listSessions(pool, {
      from,
      to: through,
      status: "pending",
      ...filter,
    });
    return {
      status: "ready",
      from,
      through,
      items: audience === "individual"
        ? sessions.map(individualPortalAssignment)
        : sessions.map(employeePortalAssignment),
    };
  } catch {
    return { status: "unavailable", from, through, items: [] };
  }
}

export async function individualPortalUpcomingSchedule(
  pool: PgLikePool,
  individualId: string,
  from?: string,
): Promise<PortalUpcomingSchedule> {
  return upcomingSchedule(pool, { individualId }, "individual", from);
}

export async function employeePortalUpcomingSchedule(
  pool: PgLikePool,
  employeeId: string,
  from?: string,
): Promise<PortalUpcomingSchedule> {
  return upcomingSchedule(pool, { employeeId }, "employee", from);
}
