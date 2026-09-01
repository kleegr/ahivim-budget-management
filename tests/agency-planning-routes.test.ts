import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SERIES_ID = "00000000-0000-4000-8000-000000000001";
const PROGRAM_ID = "00000000-0000-4000-8000-000000000002";
const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000003";
const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000004";

const mocks = vi.hoisted(() => ({
  apiPlanningUser: vi.fn(),
  planningSubjectsAllowed: vi.fn(),
  planningEmployeeIdsAllowedForSubjects: vi.fn(),
  planningProgramAllowed: vi.fn(),
  planningSeriesAllowed: vi.fn(),
  getPool: vi.fn(),
  previewSession: vi.fn(),
  listEmployeeAvailability: vi.fn(),
  projectSeriesAuthorization: vi.fn(),
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
  cancelSeries: mocks.cancelSeries,
  updateSeries: mocks.updateSeries,
}));
vi.mock("@/lib/data/employee-availability", () => ({
  listEmployeeAvailability: mocks.listEmployeeAvailability,
}));
vi.mock("@/lib/data/series-authorization", () => ({
  projectSeriesAuthorization: mocks.projectSeriesAuthorization,
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
      user: { id: "user" },
      agencyIds: [SERIES_ID],
      canManageSchedules: true,
      access: { canSeeBudgets: true },
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
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps authorization details out of a staffing-only recurrence preview", async () => {
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "user" },
      agencyIds: [],
      canManageSchedules: true,
      access: { canSeeBudgets: false },
    });
    mocks.previewSession.mockResolvedValue({
      durationHours: "2.0000",
      warnings: [
        { code: "over_authorized_hours", message: "Authorized hours would be exceeded." },
        { code: "custom_note", message: "Review the service note." },
      ],
      forecast: [{ individualId: INDIVIDUAL_ID, remainingHours: "10" }],
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
    ]);
    expect(body.data.forecast).toEqual([]);
    expect(body.data.seriesAuthorization).toBeNull();
    expect(mocks.projectSeriesAuthorization).not.toHaveBeenCalled();
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
      "user",
      null,
      { enforceBudgetWarnings: true },
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
