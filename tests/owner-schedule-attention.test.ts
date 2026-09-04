import { describe, expect, it } from "vitest";
import type { CalendarSession, SessionWarningFlags } from "@/lib/data/schedule-queries";
import { buildOwnerScheduleAttention } from "@/lib/dashboard/owner-schedule-attention";

function session(overrides: Partial<CalendarSession>): CalendarSession {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    seriesId: null,
    sessionDate: "2026-09-05",
    startTime: "09:00",
    endTime: "11:00",
    durationHours: "2.0000",
    employeeId: "20000000-0000-4000-8000-000000000001",
    employeeName: "Eli Worker",
    programId: "30000000-0000-4000-8000-000000000001",
    programName: "Community Habilitation",
    isGroup: false,
    groupSize: 1,
    individualNames: ["Ari Person"],
    individualIds: ["40000000-0000-4000-8000-000000000001"],
    status: "pending",
    warningCount: 0,
    canChangeSchedule: true,
    ...overrides,
  };
}

function warning(id: string, overrides: Partial<SessionWarningFlags>): SessionWarningFlags {
  return { id, hasConflict: false, hasBudgetRisk: false, warningCount: 0, ...overrides };
}

describe("buildOwnerScheduleAttention", () => {
  it("keeps the exact next unassigned visit and conflict in the 30-day owner queue", () => {
    const conflictId = "10000000-0000-4000-8000-000000000002";
    const unassignedId = "10000000-0000-4000-8000-000000000003";
    const completedId = "10000000-0000-4000-8000-000000000004";
    const result = buildOwnerScheduleAttention({
      from: "2026-09-04",
      through: "2026-10-04",
      sessions: [
        session({ id: conflictId }),
        session({
          id: unassignedId,
          sessionDate: "2026-09-06",
          employeeId: null,
          employeeName: null,
          individualNames: ["Bea Person"],
        }),
        session({ id: completedId, status: "completed", employeeId: null, employeeName: null }),
      ],
      warningFlags: [
        warning(conflictId, { hasConflict: true, warningCount: 1 }),
        warning(unassignedId, {}),
        warning(completedId, { hasConflict: true, warningCount: 1 }),
      ],
    });

    expect(result).toMatchObject({
      from: "2026-09-04",
      through: "2026-10-04",
      conflictCount: 1,
      unassignedCount: 1,
    });
    expect(result.nextConflict).toMatchObject({
      id: conflictId,
      individualNames: ["Ari Person"],
      href: `/schedule?view=calendar&date=2026-09-05&calendarView=day&sessionId=${conflictId}`,
    });
    expect(result.nextUnassigned).toMatchObject({
      id: unassignedId,
      individualNames: ["Bea Person"],
      href: `/schedule?view=calendar&date=2026-09-06&calendarView=day&sessionId=${unassignedId}`,
    });
  });

  it("returns a clear empty schedule signal when upcoming visits need no action", () => {
    const safe = session({});
    expect(buildOwnerScheduleAttention({
      from: "2026-09-04",
      through: "2026-10-04",
      sessions: [safe],
      warningFlags: [warning(safe.id, {})],
    })).toEqual({
      from: "2026-09-04",
      through: "2026-10-04",
      unassignedCount: 0,
      conflictCount: 0,
      nextUnassigned: null,
      nextConflict: null,
    });
  });
});
