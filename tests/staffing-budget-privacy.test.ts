import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutPlanningBudgetDetails } from "@/lib/auth/planning-access";
import type { PlanningWorkspaceData } from "@/lib/data/planning-queries";
import { warningsRequiringScheduleOverride } from "@/lib/manage/schedule";

const workspace: PlanningWorkspaceData = {
  asOf: "2026-09-01",
  workQueue: [
    {
      id: "budget-only",
      sessionDate: "2026-09-02",
      startTime: "09:00",
      durationHours: "2",
      employeeId: "employee-1",
      employeeName: "Employee One",
      programId: "program-1",
      programName: "Com Hab",
      individualIds: ["individual-1"],
      individualNames: ["Individual One"],
      reasonCodes: ["over_budget"],
      warningMessages: ["Only 1 authorized hour remains."],
    },
    {
      id: "operational",
      sessionDate: "2026-09-03",
      startTime: null,
      durationHours: "2",
      employeeId: null,
      employeeName: null,
      programId: "program-1",
      programName: "Com Hab",
      individualIds: ["individual-1"],
      individualNames: ["Individual One"],
      reasonCodes: ["unassigned", "authorization_gap"],
      warningMessages: ["No authorization was found."],
    },
  ],
  workQueueTotal: 2,
  coverage: [{
    authorizationId: "authorization-1",
    individualId: "individual-1",
    individualName: "Individual One",
    programId: "program-1",
    programCode: "CH",
    programName: "Com Hab",
    periodLabel: "2026",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    authorizedHours: "100",
    actualHours: "50",
    scheduledHours: "10",
    unplannedHours: "40",
    requiredWeeklyHours: "1",
    targetToDateHours: "60",
    paceGapHours: "10",
    usagePercent: "50",
    committedPercent: "60",
    timeElapsedPercent: "66",
    status: "plan_gap",
    eligibleEmployeeCount: 1,
    eligibleEmployeeIds: ["employee-1"],
    nextScheduledDate: "2026-09-02",
    sourceCandidateCount: 1,
    sourceAmbiguous: false,
  }],
  series: [{
    id: "series-1",
    supersedesSeriesId: null,
    successorSeriesId: null,
    employeeId: "employee-1",
    employeeName: "Employee One",
    programId: "program-1",
    programName: "Com Hab",
    frequency: "weekly",
    interval: 1,
    weekdays: [1],
    startDate: "2026-09-01",
    endDate: "2026-12-31",
    startTime: "09:00",
    endTime: "11:00",
    durationHours: "2",
    serviceType: null,
    notes: null,
    participantIds: ["individual-1"],
    participantNames: ["Individual One"],
    futureOccurrenceCount: 12,
    nextOccurrenceDate: "2026-09-07",
    issueCodes: ["conflict", "over_budget", "authorization_gap"],
  }],
  authorizationGaps: [{
    authorizationId: "authorization-1",
    individualId: "individual-1",
    individualName: "Individual One",
    programId: "program-1",
    programName: "Com Hab",
    periodLabel: "2026",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    employeeIds: ["employee-1"],
    employeeNames: ["Employee One"],
    gap: "coverage_gap",
  }],
  assignments: [{
    id: "assignment-1",
    employeeId: "employee-1",
    employeeName: "Employee One",
    individualId: "individual-1",
    individualName: "Individual One",
    programId: "program-1",
    programName: "Com Hab",
    startDate: "2026-01-01",
    endDate: null,
    allowedHours: "100",
    notes: "Primary worker",
    timing: "current",
  }],
  nextSevenDaySessions: [{
    sessionDate: "2026-09-02",
    employeeId: "employee-1",
    individualIds: ["individual-1"],
    hours: "2",
  }],
  summary: {
    activeSchedules: 1,
    scheduledNextSevenDaysHours: "2",
    unassignedSessions: 1,
    conflictedSessions: 1,
    overBudgetSessions: 1,
    coverageGaps: 1,
    futurePlanGaps: 2,
  },
};

describe("staffing-only planning privacy", () => {
  it("classifies ambiguous authorization warnings as budget-only", () => {
    const source = readFileSync("src/lib/data/planning-queries.ts", "utf8");

    expect(source).toMatch(/AUTHORIZATION_WARNING_CODES[\s\S]*?"ambiguous_authorization"/);
    expect(source.match(/authorization_state\.authorization_count <> 1/g)).toHaveLength(2);
    expect(source.match(/authorization_state\.source_ambiguous/g)).toHaveLength(2);
    expect(source.match(/bool_or\(ea\.source_candidate_count > 1\)/g)).toHaveLength(2);
    expect(source).toMatch(/'outside_authorization_dates',[\s\S]*?'ambiguous_authorization'/);
  });

  it("does not block a staffing save on budget warnings hidden from that role", () => {
    const warnings = [
      { code: "over_authorized_hours", severity: "warning" as const, message: "Over hours" },
      { code: "employee_double_booked", severity: "warning" as const, message: "Employee is busy" },
      { code: "missing_rate", severity: "warning" as const, message: "No rate" },
    ];

    expect(warningsRequiringScheduleOverride(warnings, { enforceBudgetWarnings: false }))
      .toEqual([warnings[1]]);
    expect(warningsRequiringScheduleOverride(warnings, { enforceBudgetWarnings: true }))
      .toEqual([warnings[0], warnings[1]]);
  });

  it("removes authorization details while preserving operational scheduling data", () => {
    const result = withoutPlanningBudgetDetails(workspace);

    expect(result.coverage).toEqual([]);
    expect(result.authorizationGaps).toEqual([]);
    expect(result.assignments[0]?.allowedHours).toBeNull();
    expect(result.workQueue).toEqual([
      expect.objectContaining({ id: "operational", reasonCodes: ["unassigned"], warningMessages: [] }),
    ]);
    expect(result.workQueueTotal).toBe(1);
    expect(result.series[0]?.issueCodes).toEqual(["conflict"]);
    expect(result.summary).toEqual(expect.objectContaining({
      overBudgetSessions: 0,
      coverageGaps: 0,
      futurePlanGaps: 1,
      conflictedSessions: 1,
    }));
    expect(result.nextSevenDaySessions).toEqual(workspace.nextSevenDaySessions);
  });
});
