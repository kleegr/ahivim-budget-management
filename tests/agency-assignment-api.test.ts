import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const EMPLOYEE_INSIDE = "00000000-0000-4000-8000-000000000001";
const EMPLOYEE_OUTSIDE = "00000000-0000-4000-8000-000000000002";
const INDIVIDUAL_INSIDE = "00000000-0000-4000-8000-000000000003";
const ASSIGNMENT = "00000000-0000-4000-8000-000000000004";

const mocks = vi.hoisted(() => ({
  apiPlanningUser: vi.fn(),
  planningSubjectsAllowed: vi.fn(),
  planningProgramAllowed: vi.fn(),
  getPool: vi.fn(),
  getAssignment: vi.fn(),
  updateAssignment: vi.fn(),
  setAssignmentStatus: vi.fn(),
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
  planningSubjectsAllowed: mocks.planningSubjectsAllowed,
  planningProgramAllowed: mocks.planningProgramAllowed,
}));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/manage/assignments", () => ({
  getAssignment: mocks.getAssignment,
  updateAssignment: mocks.updateAssignment,
  setAssignmentStatus: mocks.setAssignmentStatus,
}));

import { PATCH } from "@/app/api/assignments/[id]/route";

describe("agency assignment mutation scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "user" },
      canManageAssignments: true,
      access: { canSeeBudgets: true },
    });
    mocks.getPool.mockReturnValue({});
    mocks.getAssignment.mockResolvedValue({
      id: ASSIGNMENT,
      employeeId: EMPLOYEE_INSIDE,
      individualId: INDIVIDUAL_INSIDE,
    });
    mocks.planningSubjectsAllowed.mockImplementation((_planning, subjects) =>
      subjects.employeeId !== EMPLOYEE_OUTSIDE);
    mocks.planningProgramAllowed.mockResolvedValue(true);
    mocks.setAssignmentStatus.mockResolvedValue({ ok: true, data: { id: ASSIGNMENT } });
    mocks.updateAssignment.mockResolvedValue({ ok: true, data: { id: ASSIGNMENT } });
  });

  it("denies assignment changes to a read-only planner before opening the database", async () => {
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "read-only-planner" },
      canManageAssignments: false,
      access: { canSeeBudgets: true },
    });
    const request = new NextRequest(`http://localhost/api/assignments/${ASSIGNMENT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ notes: "blocked" }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ id: ASSIGNMENT }) });

    expect(response.status).toBe(403);
    expect(mocks.getAssignment).not.toHaveBeenCalled();
    expect(mocks.updateAssignment).not.toHaveBeenCalled();
  });

  it("rejects proposed subjects outside the agency even when the existing assignment is in scope", async () => {
    const request = new NextRequest(`http://localhost/api/assignments/${ASSIGNMENT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ employeeId: EMPLOYEE_OUTSIDE, notes: "move" }),
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: ASSIGNMENT }) });

    expect(response.status).toBe(403);
    expect(mocks.planningSubjectsAllowed).toHaveBeenLastCalledWith(
      expect.anything(),
      { individualIds: [INDIVIDUAL_INSIDE], employeeId: EMPLOYEE_OUTSIDE },
      "assignment",
      { from: undefined, to: undefined },
    );
    expect(mocks.updateAssignment).not.toHaveBeenCalled();
  });

  it("allows an in-scope inactive hours assignment to be ended without treating it as a replacement", async () => {
    const request = new NextRequest(`http://localhost/api/assignments/${ASSIGNMENT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action: "end" }),
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: ASSIGNMENT }) });

    expect(response.status).toBe(200);
    expect(mocks.planningProgramAllowed).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      { allowInactive: true },
    );
    expect(mocks.setAssignmentStatus).toHaveBeenCalledWith(
      expect.anything(), ASSIGNMENT, "ended", "user", null,
    );
    expect(mocks.updateAssignment).not.toHaveBeenCalled();
  });

  it("ignores allowed-hour edits from a staffing-only account", async () => {
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "user" },
      canManageAssignments: true,
      access: { canSeeBudgets: false },
    });
    const request = new NextRequest(`http://localhost/api/assignments/${ASSIGNMENT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ allowedHours: "100", notes: "Staffing update" }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ id: ASSIGNMENT }) });

    expect(response.status).toBe(200);
    expect(mocks.updateAssignment).toHaveBeenCalledWith(
      expect.anything(),
      ASSIGNMENT,
      { notes: "Staffing update" },
      "user",
      null,
    );
  });
});
