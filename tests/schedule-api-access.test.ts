import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiPlanningUser: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock("@/lib/auth/planning-access", () => ({
  apiPlanningUser: mocks.apiPlanningUser,
  isBudgetPlanningWarningCode: vi.fn(() => false),
}));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));

import { GET as listSessions, POST as createSession } from "@/app/api/schedule/sessions/route";
import { GET as getSession, PATCH as updateSession } from "@/app/api/schedule/sessions/[id]/route";
import { POST as previewSchedule } from "@/app/api/schedule/preview/route";
import { POST as createSeries } from "@/app/api/schedule/series/route";
import { PATCH as updateSeries } from "@/app/api/schedule/series/[id]/route";
import { GET as getUtilization } from "@/app/api/schedule/utilization/route";

const ID = "00000000-0000-4000-8000-000000000001";
const params = { params: Promise.resolve({ id: ID }) };

function request(path: string, method: "GET" | "POST" | "PATCH" = "GET"): NextRequest {
  return new NextRequest(`http://localhost${path}`, method === "GET" ? undefined : {
    method,
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

describe("planning API authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiPlanningUser.mockResolvedValue(null);
  });

  const cases: Array<[string, () => Promise<Response>]> = [
    ["list sessions", () => listSessions(request("/api/schedule/sessions"))],
    ["create a session", () => createSession(request("/api/schedule/sessions", "POST"))],
    ["read a session", () => getSession(request(`/api/schedule/sessions/${ID}`), params)],
    ["change a session", () => updateSession(request(`/api/schedule/sessions/${ID}`, "PATCH"), params)],
    ["preview a schedule", () => previewSchedule(request("/api/schedule/preview", "POST"))],
    ["create a series", () => createSeries(request("/api/schedule/series", "POST"))],
    ["change a series", () => updateSeries(request(`/api/schedule/series/${ID}`, "PATCH"), params)],
    ["read utilization", () => getUtilization(request(`/api/schedule/utilization?individualId=${ID}`))],
  ];

  it.each(cases)("denies %s before opening the database", async (_label, invoke) => {
    const response = await invoke();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "Planning access required" });
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it("denies utilization data to a staffing-only planner before opening the database", async () => {
    mocks.apiPlanningUser.mockResolvedValue({ access: { canSeeBudgets: false } });

    const response = await getUtilization(request(`/api/schedule/utilization?individualId=${ID}`));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "Budget planning access required" });
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it("lets a read-only planner reach reads but denies every session and series mutation", async () => {
    mocks.apiPlanningUser.mockResolvedValue({
      user: { id: "read-only-planner" },
      access: { canSeeBudgets: true },
      canManageSchedules: false,
    });

    const writes = [
      await createSession(request("/api/schedule/sessions", "POST")),
      await updateSession(request(`/api/schedule/sessions/${ID}`, "PATCH"), params),
      await createSeries(request("/api/schedule/series", "POST")),
      await updateSeries(request(`/api/schedule/series/${ID}`, "PATCH"), params),
    ];

    for (const response of writes) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: "Schedule management access required" });
    }
    expect(mocks.getPool).not.toHaveBeenCalled();
  });
});
