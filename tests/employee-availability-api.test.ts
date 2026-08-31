import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const EMPLOYEE_ID = "30000000-0000-4000-8000-000000000001";
const WINDOW_ID = "40000000-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  apiPlanningUser: vi.fn(),
  planningEmployeeAllowed: vi.fn(),
  getPool: vi.fn(),
  listRules: vi.fn(),
  createWeekly: vi.fn(),
  createUnavailable: vi.fn(),
  getWeekly: vi.fn(),
  getUnavailable: vi.fn(),
  archiveWeekly: vi.fn(),
  archiveUnavailable: vi.fn(),
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
  planningEmployeeAllowed: mocks.planningEmployeeAllowed,
}));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/manage/employee-availability", () => ({
  listEmployeeAvailabilityRules: mocks.listRules,
  createWeeklyAvailabilityWindow: mocks.createWeekly,
  createEmployeeUnavailabilityWindow: mocks.createUnavailable,
  getWeeklyAvailabilityWindow: mocks.getWeekly,
  getEmployeeUnavailabilityWindow: mocks.getUnavailable,
  archiveWeeklyAvailabilityWindow: mocks.archiveWeekly,
  archiveEmployeeUnavailabilityWindow: mocks.archiveUnavailable,
}));

import { GET, POST } from "@/app/api/employee-availability/route";
import { PATCH } from "@/app/api/employee-availability/[id]/route";

function request(path: string, method = "GET", body?: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body ? { "content-type": "application/json", origin: "http://localhost" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("employee availability API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPool.mockReturnValue({});
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "planner" },
      agencyIds: [],
      agencyRosters: [],
      canManageAssignments: true,
    });
    mocks.planningEmployeeAllowed.mockReturnValue(true);
    mocks.listRules.mockResolvedValue({ weekly: [], unavailable: [] });
    mocks.createWeekly.mockResolvedValue({ ok: true, data: { id: WINDOW_ID, kind: "weekly" } });
    mocks.getWeekly.mockResolvedValue({
      id: WINDOW_ID,
      kind: "weekly",
      employeeId: EMPLOYEE_ID,
      effectiveFrom: "2026-09-01",
      effectiveTo: null,
    });
    mocks.archiveWeekly.mockResolvedValue({ ok: true, data: { id: WINDOW_ID, kind: "weekly" } });
  });

  it("allows a read-only planner to view finance-free employee hours", async () => {
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "viewer" },
      agencyIds: [],
      agencyRosters: [],
      canManageAssignments: false,
    });
    const response = await GET(request(`/api/employee-availability?employeeId=${EMPLOYEE_ID}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { weekly: [], unavailable: [] } });
    expect(mocks.listRules).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      employeeId: EMPLOYEE_ID,
    }));
  });

  it("keeps writes limited to staffing managers", async () => {
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "viewer" },
      agencyIds: [],
      agencyRosters: [],
      canManageAssignments: false,
    });
    const response = await POST(request("/api/employee-availability", "POST", {
      kind: "weekly",
      employeeId: EMPLOYEE_ID,
      weekday: 1,
      startTime: "09:00",
      endTime: "17:00",
      effectiveFrom: "2026-09-01",
    }));

    expect(response.status).toBe(403);
    expect(mocks.createWeekly).not.toHaveBeenCalled();
  });

  it("creates an in-scope weekly window through the audited helper", async () => {
    const body = {
      kind: "weekly",
      employeeId: EMPLOYEE_ID,
      weekday: 1,
      startTime: "09:00",
      endTime: "17:00",
      effectiveFrom: "2026-09-01",
      reason: "Hours confirmed",
    };
    const response = await POST(request("/api/employee-availability", "POST", body));

    expect(response.status).toBe(201);
    expect(mocks.createWeekly).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ employeeId: EMPLOYEE_ID, weekday: 1 }),
      "planner",
      "Hours confirmed",
    );
  });

  it("hides an out-of-scope employee before creating a rule", async () => {
    mocks.planningEmployeeAllowed.mockReturnValue(false);
    const response = await POST(request("/api/employee-availability", "POST", {
      kind: "unavailable",
      employeeId: EMPLOYEE_ID,
      startDate: "2026-09-07",
      endDate: "2026-09-07",
    }));

    expect(response.status).toBe(403);
    expect(mocks.createUnavailable).not.toHaveBeenCalled();
  });

  it("archives an in-scope rule without deleting it", async () => {
    const response = await PATCH(
      request(`/api/employee-availability/${WINDOW_ID}`, "PATCH", {
        action: "archive",
        kind: "weekly",
        reason: "New schedule",
      }),
      { params: Promise.resolve({ id: WINDOW_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.archiveWeekly).toHaveBeenCalledWith(
      expect.anything(), WINDOW_ID, "planner", "New schedule",
    );
  });
});
