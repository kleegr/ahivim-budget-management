import { describe, expect, it } from "vitest";
import { buildScheduleAttention } from "@/lib/business/schedule-attention";
import type { CalendarSession, SessionWarningFlags } from "@/lib/data/schedule-queries";

function session(overrides: Partial<CalendarSession> = {}): CalendarSession {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    seriesId: null,
    sessionDate: "2026-09-07",
    startTime: "09:00",
    endTime: "11:00",
    durationHours: "2.0000",
    employeeId: "30000000-0000-4000-8000-000000000001",
    employeeName: "Alice Green",
    programId: "10000000-0000-4000-8000-000000000001",
    programName: "Community Habilitation",
    isGroup: false,
    groupSize: 1,
    individualNames: ["Ari Cohen"],
    individualIds: ["20000000-0000-4000-8000-000000000001"],
    status: "pending",
    warningCount: 0,
    canChangeSchedule: true,
    ...overrides,
  };
}

function flags(overrides: Partial<SessionWarningFlags> = {}): SessionWarningFlags {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    hasConflict: false,
    hasScheduleConflict: false,
    hasAvailabilityConflict: false,
    hasBudgetRisk: false,
    hasAssignmentGap: false,
    hasOtherWarning: false,
    warningCount: 0,
    ...overrides,
  };
}

describe("schedule attention queue", () => {
  it("gives every operational exception one direct repair", () => {
    const visit = session({ warningCount: 4 });
    const rows = buildScheduleAttention([visit], new Map([[visit.id, flags({
      hasConflict: true,
      hasScheduleConflict: true,
      hasAvailabilityConflict: true,
      hasBudgetRisk: true,
      hasAssignmentGap: true,
      warningCount: 4,
    })]]), { showBudgetTracking: true });

    expect(rows.map((row) => [row.title, row.repair, row.actionLabel])).toEqual([
      ["Employee unavailable", "staffing", "Change employee"],
      ["Schedule conflict", "reschedule", "Reschedule visit"],
      ["Assignment missing", "assignment", "Fix assignment"],
      ["Budget coverage needs review", "coverage", "Review coverage"],
    ]);
  });

  it("makes an unassigned visit actionable even without a stored warning", () => {
    const visit = session({ employeeId: null, employeeName: null });
    const rows = buildScheduleAttention([visit], new Map(), { showBudgetTracking: true });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repair: "staffing", actionLabel: "Find employee" });
  });

  it("removes budget-only exceptions from a staffing planner's queue", () => {
    const visit = session({ warningCount: 1 });
    const warning = flags({ hasBudgetRisk: true, warningCount: 1 });

    expect(buildScheduleAttention([visit], new Map([[visit.id, warning]]), {
      showBudgetTracking: false,
    })).toEqual([]);
  });

  it("keeps completed and other historical visits out of the repair queue", () => {
    const completed = session({ status: "completed", employeeId: null, employeeName: null });
    const cancelled = session({ id: "40000000-0000-4000-8000-000000000002", status: "cancelled", employeeId: null, employeeName: null });

    expect(buildScheduleAttention([completed, cancelled], new Map(), {
      showBudgetTracking: true,
    })).toEqual([]);
  });

  it("never adds financial or actual-service fields to the repair DTO", () => {
    const visit = session({ employeeId: null, employeeName: null });
    const serialized = JSON.stringify(buildScheduleAttention([visit], new Map(), {
      showBudgetTracking: true,
    })).toLocaleLowerCase();

    for (const forbidden of ["amount", "rate", "check", "transaction", "net", "tax"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
