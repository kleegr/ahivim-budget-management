import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SERIES_ID = "00000000-0000-4000-8000-000000000001";
const PROGRAM_ID = "00000000-0000-4000-8000-000000000002";
const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000003";
const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000004";

const mocks = vi.hoisted(() => ({
  apiPlanningUser: vi.fn(),
  canViewPlannerDirectPayTargets: vi.fn(),
  planningSubjectsAllowed: vi.fn(),
  planningEmployeeIdsAllowedForSubjects: vi.fn(),
  planningProgramAllowed: vi.fn(),
  planningSeriesAllowed: vi.fn(),
  getPool: vi.fn(),
  previewSession: vi.fn(),
  assignmentAllowedHoursWarning: vi.fn(),
  directPayScheduleLimitWarning: vi.fn(),
  listEmployeeAvailability: vi.fn(),
  projectSeriesAuthorization: vi.fn(),
  projectSeriesAssignmentAllowedHours: vi.fn(),
  projectDirectPayScheduleLimits: vi.fn(),
  resolveSchedulePaymentRecipients: vi.fn(),
  listIndividualScheduleConflicts: vi.fn(),
  projectSeries: vi.fn(),
  getSession: vi.fn(),
  cancelSeries: vi.fn(),
  updateSeries: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextRequest: Request,
  NextResponse: class TestNextResponse extends Response {
    static json(body: unknown, init?: ResponseInit) {
      const headers = new Headers(init?.headers);
      headers.set("content-type", "application/json");
      return new TestNextResponse(JSON.stringify(body), { ...init, headers });
    }
  },
}));

vi.mock("@/lib/auth/planning-access", () => ({
  apiPlanningUser: mocks.apiPlanningUser,
  canViewPlannerDirectPayTargets: mocks.canViewPlannerDirectPayTargets,
  isBudgetPlanningWarningCode: (code: unknown) => [
    "over_authorized_hours",
    "missing_authorization",
    "outside_authorization_dates",
    "ambiguous_authorization",
  ].includes(String(code)),
  planningSubjectsAllowed: mocks.planningSubjectsAllowed,
  planningEmployeeIdsAllowedForSubjects: mocks.planningEmployeeIdsAllowedForSubjects,
  planningProgramAllowed: mocks.planningProgramAllowed,
  planningSeriesAllowed: mocks.planningSeriesAllowed,
}));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/manage/schedule", () => ({
  previewSession: mocks.previewSession,
  assignmentAllowedHoursWarning: mocks.assignmentAllowedHoursWarning,
  directPayScheduleLimitWarning: mocks.directPayScheduleLimitWarning,
  cancelSeries: mocks.cancelSeries,
  updateSeries: mocks.updateSeries,
}));
vi.mock("@/lib/data/employee-availability", () => ({
  listEmployeeAvailability: mocks.listEmployeeAvailability,
}));
vi.mock("@/lib/data/series-authorization", () => ({
  projectSeriesAuthorization: mocks.projectSeriesAuthorization,
}));
vi.mock("@/lib/data/assignment-allowed-hours", () => ({
  projectSeriesAssignmentAllowedHours: mocks.projectSeriesAssignmentAllowedHours,
}));
vi.mock("@/lib/data/direct-pay-schedule-limit", () => ({
  projectDirectPayScheduleLimits: mocks.projectDirectPayScheduleLimits,
}));
vi.mock("@/lib/data/schedule-payment-routing", () => ({
  resolveSchedulePaymentRecipients: mocks.resolveSchedulePaymentRecipients,
}));
vi.mock("@/lib/data/individual-schedule-conflicts", () => ({
  listIndividualScheduleConflicts: mocks.listIndividualScheduleConflicts,
}));
vi.mock("@/lib/business/planning-projection", () => ({ projectSeries: mocks.projectSeries }));
vi.mock("@/lib/data/schedule-queries", () => ({ getSession: mocks.getSession }));

import { POST as previewSchedule } from "@/app/api/schedule/preview/route";
import { PATCH as patchSeries } from "@/app/api/schedule/series/[id]/route";

function mutationRequest(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

describe("agency planning route ranges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "user", actorId: "owner" },
      agencyIds: [SERIES_ID],
      canManageSchedules: true,
      access: { canSeeBudgets: true, canSeeHours: true },
    });
    mocks.getPool.mockReturnValue({ query: vi.fn() });
    mocks.planningSubjectsAllowed.mockReturnValue(true);
    mocks.planningEmployeeIdsAllowedForSubjects.mockReturnValue([EMPLOYEE_ID]);
    mocks.planningProgramAllowed.mockResolvedValue(true);
    mocks.planningSeriesAllowed.mockResolvedValue(true);
    mocks.projectSeries.mockReturnValue({
      dates: ["2026-08-03", "2026-08-10"],
      occurrenceCount: 2,
    });
    mocks.previewSession.mockResolvedValue({ durationHours: "2.0000", warnings: [], forecast: [] });
    mocks.listEmployeeAvailability.mockResolvedValue({ timeRangeKnown: true, occurrenceCount: 2, employees: [] });
    mocks.listIndividualScheduleConflicts.mockResolvedValue({ occurrenceCount: 2, individuals: [] });
    mocks.projectSeriesAuthorization.mockResolvedValue({ entries: [] });
    mocks.projectSeriesAssignmentAllowedHours.mockResolvedValue({
      occurrenceCount: 2,
      durationHours: "2.0000",
      assignments: [],
    });
    mocks.canViewPlannerDirectPayTargets.mockImplementation(
      (planning: { agencyIds: string[]; access: { canSeeHours: boolean } }) =>
        planning.agencyIds.length === 0 && planning.access.canSeeHours,
    );
    mocks.assignmentAllowedHoursWarning.mockImplementation((
      _assignment: unknown,
      _duration: unknown,
      occurrence: { number: number; date: string },
    ) => ({
      code: "over_assignment_allowed_hours",
      severity: "warning",
      message: `Occurrence ${occurrence.number} on ${occurrence.date} crosses the assignment limit.`,
      record: { type: "assignment", id: "assignment-1", label: "Alice / Ari" },
      action: { label: "Review assignment", href: "/schedule?view=future" },
    }));
    mocks.resolveSchedulePaymentRecipients.mockResolvedValue(new Map());
    mocks.projectDirectPayScheduleLimits.mockResolvedValue([]);
    mocks.directPayScheduleLimitWarning.mockReturnValue(null);
    mocks.cancelSeries.mockResolvedValue({ ok: true, data: { cancelled: 2 } });
    mocks.updateSeries.mockResolvedValue({ ok: true, data: { seriesId: SERIES_ID } });
  });

  it("authorizes recurrence preview from its apply date and scopes availability to shared employees", async () => {
    const response = await previewSchedule(mutationRequest("/api/schedule/preview", {
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      sessionDate: "2026-01-05",
      startTime: "09:00",
      endTime: "11:00",
      durationHours: "2",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: [1],
        startDate: "2026-01-05",
        applyFromDate: "2026-08-01",
        endDate: "2026-12-31",
      },
    }));

    expect(response.status).toBe(200);
    expect(mocks.planningSubjectsAllowed).toHaveBeenCalledWith(
      expect.anything(),
      { individualIds: [INDIVIDUAL_ID], employeeId: EMPLOYEE_ID },
      "read",
      { from: "2026-08-01", to: "2026-12-31" },
    );
    expect(mocks.planningEmployeeIdsAllowedForSubjects).toHaveBeenCalledWith(
      expect.anything(),
      [INDIVIDUAL_ID],
      { from: "2026-08-01", to: "2026-12-31" },
    );
    expect(mocks.listEmployeeAvailability).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      employeeIds: [EMPLOYEE_ID],
    }));
  });

  it("returns the exact cumulative assignment-limit crossing for the full recurrence", async () => {
    mocks.projectSeries.mockReturnValue({
      dates: ["2026-08-03", "2026-08-10", "2026-08-17"],
      occurrenceCount: 3,
    });
    const assignment = {
      assignmentId: "00000000-0000-4000-8000-000000000005",
      employeeId: EMPLOYEE_ID,
      employeeName: "Alice Employee",
      individualId: INDIVIDUAL_ID,
      individualName: "Ari Individual",
      programId: PROGRAM_ID,
      programName: "Com Hab",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      allowedHours: "10.0000",
      actualHours: "2.0000",
      scheduledHours: "4.0000",
      remainingHours: "4.0000",
      overLimit: false,
    };
    mocks.projectSeriesAssignmentAllowedHours.mockResolvedValue({
      occurrenceCount: 3,
      durationHours: "2.0000",
      assignments: [{
        assignment,
        seriesOccurrenceCount: 3,
        seriesHours: "6.0000",
        remainingAfterHours: "-2.0000",
        overLimit: true,
        crossingOccurrence: {
          occurrenceDate: "2026-08-17",
          occurrenceNumber: 3,
          assignmentOccurrenceNumber: 3,
          scheduledBeforeHours: "8.0000",
          projectedScheduledHours: "10.0000",
          projectedTotalHours: "12.0000",
          remainingHours: "-2.0000",
          overByHours: "2.0000",
        },
      }],
    });
    const response = await previewSchedule(mutationRequest("/api/schedule/preview", {
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      sessionDate: "2026-08-03",
      startTime: "09:00",
      endTime: "11:00",
      durationHours: "2",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: [1],
        startDate: "2026-08-03",
        endDate: "2026-08-31",
      },
    }));

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.projectSeriesAssignmentAllowedHours).toHaveBeenCalledWith(expect.anything(), {
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      occurrenceDates: ["2026-08-03", "2026-08-10", "2026-08-17"],
      durationHours: "2.0000",
      excludeSessionId: null,
      excludeSeriesId: null,
      excludeSeriesFromDate: "2026-08-03",
    });
    expect(mocks.assignmentAllowedHoursWarning).toHaveBeenCalledWith({
      ...assignment,
      scheduledHours: "8.0000",
    }, "2.0000", {
      date: "2026-08-17",
      number: 3,
    });
    expect(body.data.warnings).toEqual([expect.objectContaining({
      code: "over_assignment_allowed_hours",
      message: "Occurrence 3 on 2026-08-17 crosses the assignment limit.",
      record: expect.objectContaining({ type: "assignment" }),
      action: expect.objectContaining({ label: "Review assignment" }),
    })]);
  });

  it("returns one hours-only Direct-Pay target warning for the exact recurring window", async () => {
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "user" },
      agencyIds: [],
      canManageSchedules: true,
      access: { canSeeBudgets: true, canSeeHours: true },
    });
    const dates = ["2026-08-03", "2026-08-10", "2026-08-17"];
    mocks.projectSeries.mockReturnValue({ dates, occurrenceCount: dates.length });
    mocks.resolveSchedulePaymentRecipients.mockResolvedValue(new Map(
      dates.map((date) => [date, "employee"]),
    ));
    const targetProjection = {
      targetId: "00000000-0000-4000-8000-000000000006",
      employeeId: EMPLOYEE_ID,
      employeeName: "Alice Employee",
      windowStart: "2026-08-01",
      windowEnd: "2026-08-31",
      targetHours: "10.0000",
      recordedHours: "2.0000",
      scheduledHours: "4.0000",
      candidateHours: "6.0000",
      candidateOccurrenceCount: 3,
      projectedHours: "12.0000",
      overageHours: "2.0000",
      overLimit: true,
      crossingOccurrence: { occurrenceDate: "2026-08-17", occurrenceNumber: 3 },
    };
    mocks.projectDirectPayScheduleLimits.mockResolvedValue([targetProjection]);
    mocks.directPayScheduleLimitWarning.mockReturnValue({
      code: "over_direct_pay_target_hours",
      severity: "warning",
      message: "Occurrence 3 on 2026-08-17 crosses the Direct-Pay target.",
      record: {
        type: "employee_direct_pay_target",
        id: targetProjection.targetId,
        label: "Alice Employee / August",
      },
      action: { label: "Review Direct-Pay target", href: "/schedule?view=targets" },
    });

    const response = await previewSchedule(mutationRequest("/api/schedule/preview", {
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      sessionDate: dates[0],
      durationHours: "2",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: [1],
        startDate: dates[0],
        endDate: "2026-08-31",
      },
    }));

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.projectDirectPayScheduleLimits).toHaveBeenCalledWith(expect.anything(), {
      employeeId: EMPLOYEE_ID,
      occurrenceDates: dates,
      occurrenceNumbers: {
        "2026-08-03": 1,
        "2026-08-10": 2,
        "2026-08-17": 3,
      },
      durationHours: "2.0000",
      asOfDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      excludeSessionId: null,
      excludeSeriesId: null,
      excludeSeriesFromDate: dates[0],
    });
    expect(mocks.directPayScheduleLimitWarning).toHaveBeenCalledWith(targetProjection);
    expect(body.data.warnings).toEqual([expect.objectContaining({
      code: "over_direct_pay_target_hours",
      record: expect.objectContaining({ type: "employee_direct_pay_target" }),
      action: expect.objectContaining({ label: "Review Direct-Pay target" }),
    })]);
  });

  it("does not evaluate or disclose employee-wide Direct-Pay targets to an agency planner", async () => {
    mocks.previewSession.mockResolvedValue({
      durationHours: "2.0000",
      warnings: [
        { code: "over_direct_pay_target_hours", message: "Private employee target evidence" },
        { code: "custom_note", message: "Visible operational note" },
      ],
      forecast: [],
    });

    const response = await previewSchedule(mutationRequest("/api/schedule/preview", {
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      sessionDate: "2026-08-03",
      durationHours: "2",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: [1],
        startDate: "2026-08-03",
        endDate: "2026-08-31",
      },
    }));

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.previewSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null,
      expect.objectContaining({ enforceDirectPayTargetWarnings: false }),
    );
    expect(mocks.resolveSchedulePaymentRecipients).not.toHaveBeenCalled();
    expect(mocks.projectDirectPayScheduleLimits).not.toHaveBeenCalled();
    expect(body.data.warnings).toEqual([
      { code: "custom_note", message: "Visible operational note" },
    ]);
  });

  it("does not evaluate or disclose assignment-hour limits without hour visibility", async () => {
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "user" },
      agencyIds: [SERIES_ID],
      canManageSchedules: true,
      access: { canSeeBudgets: false, canSeeHours: false },
    });
    mocks.previewSession.mockResolvedValue({
      durationHours: "2.0000",
      warnings: [
        { code: "over_assignment_allowed_hours", message: "Private assignment-hour evidence" },
        { code: "custom_note", message: "Visible operational note" },
      ],
      forecast: [{ individualId: INDIVIDUAL_ID, remainingHours: "10" }],
    });

    const response = await previewSchedule(mutationRequest("/api/schedule/preview", {
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      sessionDate: "2026-08-03",
      durationHours: "2",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: [1],
        startDate: "2026-08-03",
        endDate: "2026-08-31",
      },
    }));

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.previewSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null,
      expect.objectContaining({ enforceAssignmentAllowedHoursWarnings: false }),
    );
    expect(mocks.projectSeriesAssignmentAllowedHours).not.toHaveBeenCalled();
    expect(mocks.assignmentAllowedHoursWarning).not.toHaveBeenCalled();
    expect(body.data.warnings).toEqual([
      { code: "custom_note", message: "Visible operational note" },
    ]);
    expect(body.data.forecast).toEqual([]);
  });

  it("authorizes the existing edited series over the derived apply range before reading occurrences", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ recurrence_anchor_date: "2026-01-05", start_date: "2026-01-05" }] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.getPool.mockReturnValue({ query });
    const response = await previewSchedule(mutationRequest("/api/schedule/preview", {
      editSeriesId: SERIES_ID,
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      sessionDate: "2026-01-05",
      durationHours: "2",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: [1],
        startDate: "2026-09-01",
        applyFromDate: "2026-08-01",
        endDate: "2026-12-31",
      },
    }));

    expect(response.status).toBe(200);
    expect(mocks.planningSeriesAllowed).toHaveBeenNthCalledWith(2,
      expect.anything(),
      expect.anything(),
      SERIES_ID,
      "schedule",
      { from: "2026-08-01", to: "2026-12-31" },
    );
    expect(mocks.planningSubjectsAllowed).toHaveBeenCalledWith(
      expect.anything(),
      { individualIds: [INDIVIDUAL_ID], employeeId: EMPLOYEE_ID },
      "read",
      { from: "2026-09-01", to: "2026-12-31" },
    );
    expect(mocks.listEmployeeAvailability).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      excludeSeriesFromDate: "2026-08-01",
    }));
    expect(mocks.projectSeriesAssignmentAllowedHours).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      occurrenceDates: ["2026-08-03", "2026-08-10"],
      excludeSeriesId: SERIES_ID,
      excludeSeriesFromDate: "2026-08-01",
    }));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps authorization details out of a staffing-only recurrence preview", async () => {
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "user" },
      agencyIds: [],
      canManageSchedules: true,
      access: { canSeeBudgets: false, canSeeHours: true },
    });
    mocks.previewSession.mockResolvedValue({
      durationHours: "2.0000",
      warnings: [
        { code: "over_authorized_hours", message: "Authorized hours would be exceeded." },
        { code: "custom_note", message: "Review the service note." },
      ],
      forecast: [{ individualId: INDIVIDUAL_ID, remainingHours: "10" }],
    });
    mocks.projectSeriesAssignmentAllowedHours.mockResolvedValue({
      occurrenceCount: 2,
      durationHours: "2.0000",
      assignments: [{
        assignment: {
          assignmentId: "00000000-0000-4000-8000-000000000005",
          employeeId: EMPLOYEE_ID,
          employeeName: "Alice Employee",
          individualId: INDIVIDUAL_ID,
          individualName: "Ari Individual",
          programId: PROGRAM_ID,
          programName: "Com Hab",
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          allowedHours: "3.0000",
          actualHours: "0.0000",
          scheduledHours: "0.0000",
          remainingHours: "3.0000",
          overLimit: false,
        },
        seriesOccurrenceCount: 2,
        seriesHours: "4.0000",
        remainingAfterHours: "-1.0000",
        overLimit: true,
        crossingOccurrence: {
          occurrenceDate: "2026-08-10",
          occurrenceNumber: 2,
          assignmentOccurrenceNumber: 2,
          scheduledBeforeHours: "2.0000",
          projectedScheduledHours: "4.0000",
          projectedTotalHours: "4.0000",
          remainingHours: "-1.0000",
          overByHours: "1.0000",
        },
      }],
    });

    const response = await previewSchedule(mutationRequest("/api/schedule/preview", {
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      sessionDate: "2026-08-03",
      startTime: "09:00",
      endTime: "11:00",
      durationHours: "2",
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: [1],
        startDate: "2026-08-03",
        endDate: "2026-08-31",
      },
    }));

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.warnings).toEqual([
      { code: "custom_note", message: "Review the service note." },
      expect.objectContaining({
        code: "over_assignment_allowed_hours",
        message: "Occurrence 2 on 2026-08-10 crosses the assignment limit.",
        action: expect.objectContaining({ label: "Review assignment" }),
      }),
    ]);
    expect(body.data.forecast).toEqual([]);
    expect(body.data.seriesAuthorization).toBeNull();
    expect(mocks.projectSeriesAuthorization).not.toHaveBeenCalled();
    expect(mocks.projectSeriesAssignmentAllowedHours).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      occurrenceDates: ["2026-08-03", "2026-08-10"],
    }));
  });

  it("authorizes both the existing and replacement series from applyFromDate", async () => {
    const request = mutationRequest(`/api/schedule/series/${SERIES_ID}`, {
      action: "update",
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      durationHours: "2",
      frequency: "weekly",
      interval: 1,
      weekdays: [1],
      startDate: "2026-09-01",
      applyFromDate: "2026-08-01",
      endDate: "2026-12-31",
      status: "active",
    });
    const response = await patchSeries(request, { params: Promise.resolve({ id: SERIES_ID }) });

    expect(response.status).toBe(200);
    expect(mocks.planningSeriesAllowed).toHaveBeenNthCalledWith(2,
      expect.anything(),
      expect.anything(),
      SERIES_ID,
      "schedule",
      { from: "2026-08-01", to: "2026-12-31" },
    );
    expect(mocks.planningSubjectsAllowed).toHaveBeenCalledWith(
      expect.anything(),
      { individualIds: [INDIVIDUAL_ID], employeeId: EMPLOYEE_ID },
      "schedule",
      { from: "2026-09-01", to: "2026-12-31" },
    );
    expect(mocks.updateSeries).toHaveBeenCalledWith(
      expect.anything(),
      SERIES_ID,
      expect.objectContaining({ applyFromDate: "2026-08-01", forceSplit: true }),
      "owner",
      null,
      {
        enforceBudgetWarnings: true,
        enforceAssignmentAllowedHoursWarnings: true,
        enforceDirectPayTargetWarnings: false,
      },
    );
  });

  it("cancels an existing inactive-program series without requiring a new active program", async () => {
    const request = mutationRequest(`/api/schedule/series/${SERIES_ID}`, { action: "cancel" });
    const response = await patchSeries(request, { params: Promise.resolve({ id: SERIES_ID }) });

    expect(response.status).toBe(200);
    expect(mocks.cancelSeries).toHaveBeenCalled();
    expect(mocks.planningProgramAllowed).not.toHaveBeenCalled();
  });
});
