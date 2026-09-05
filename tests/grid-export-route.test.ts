import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  resolveAccessScope: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/auth/access", () => ({ resolveAccessScope: mocks.resolveAccessScope }));

import { POST } from "@/app/api/grid/export/route";

const PAYLOAD = {
  format: "csv",
  title: "People & budgets",
  filename: "people-budgets",
  columns: [
    { key: "person", header: "Person", type: "text" },
    { key: "authorized", header: "Authorized", type: "money" },
  ],
  rows: [
    {
      person: "Rina Planner",
      authorized: "1250.5",
      unpostedColumn: "must-not-leak",
    },
  ],
};

function request(options: { origin?: string; body?: unknown; report?: string } = {}): NextRequest {
  const url = new URL("http://localhost/api/grid/export");
  if (options.report) url.searchParams.set("report", options.report);
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      ...(options.origin ? { origin: options.origin } : {}),
    },
    body: JSON.stringify(options.body ?? PAYLOAD),
  });
}

describe("generic grid export route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiUser.mockResolvedValue(null);
  });

  it("denies an unauthenticated export", async () => {
    const response = await POST(request({ origin: "http://localhost" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "Sign in to continue." });
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.resolveAccessScope).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin export", async () => {
    mocks.apiUser.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      actorId: "00000000-0000-4000-8000-000000000001",
      email: "planner@example.com",
      displayName: "Budget planner",
      role: "viewer",
    });

    const response = await POST(request({ origin: "https://attacker.example" }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Cross-origin request rejected",
    });
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.resolveAccessScope).not.toHaveBeenCalled();
  });

  it("lets an authenticated planner export only the posted columns and rows", async () => {
    mocks.apiUser.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      actorId: "00000000-0000-4000-8000-000000000001",
      email: "planner@example.com",
      displayName: "Budget planner",
      role: "viewer",
    });

    const response = await POST(request({ origin: "http://localhost" }));
    const csv = (await response.text()).replace(/^\uFEFF/, "");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv).toBe("Person,Authorized\r\nRina Planner,1250.50");
    expect(csv).not.toContain("unpostedColumn");
    expect(csv).not.toContain("must-not-leak");
    expect(mocks.apiUser).toHaveBeenCalledWith("viewer");
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.resolveAccessScope).not.toHaveBeenCalled();
  });

  it("keeps report-mode export manager-only and applies resolved report permissions", async () => {
    const user = {
      id: "00000000-0000-4000-8000-000000000001",
      actorId: "00000000-0000-4000-8000-000000000001",
      email: "manager@example.com",
      displayName: "Adjusted manager",
      role: "manager",
    };
    mocks.apiUser.mockResolvedValue({ ...user, role: "viewer" });
    const viewerResponse = await POST(request({
      origin: "http://localhost",
      report: "payroll-checks",
    }));
    expect(viewerResponse.status).toBe(403);
    expect(mocks.resolveAccessScope).not.toHaveBeenCalled();

    mocks.apiUser.mockResolvedValue(user);
    mocks.getPool.mockReturnValue({ query: vi.fn() });
    mocks.resolveAccessScope.mockResolvedValue({
      userId: user.id,
      role: "manager",
      full: true,
      allIndividuals: true,
      allEmployees: true,
      canSeeTransactions: true,
      canSeeHours: true,
      canSeeBilledAmounts: true,
      canSeeEmployeeAmounts: true,
      canSeeAgencySpread: true,
      canSeeCheckNet: false,
    });
    const deniedResponse = await POST(request({
      origin: "http://localhost",
      report: "payroll-checks",
    }));
    expect(deniedResponse.status).toBe(403);
    expect(await deniedResponse.json()).toEqual({ ok: false, error: "Report access denied" });
    expect(mocks.resolveAccessScope).toHaveBeenCalledWith(mocks.getPool.mock.results[0].value, user);

    mocks.resolveAccessScope.mockResolvedValue({
      userId: user.id,
      role: "manager",
      full: true,
      allIndividuals: true,
      allEmployees: true,
      canSeeTransactions: true,
      canSeeHours: true,
      canSeeBilledAmounts: true,
      canSeeEmployeeAmounts: true,
      canSeeAgencySpread: true,
      canSeeCheckNet: true,
    });
    const allowedResponse = await POST(request({
      origin: "http://localhost",
      report: "payroll-checks",
    }));
    expect(allowedResponse.status).toBe(200);
  });

  it("rejects resource-heavy or invalid export payloads", async () => {
    mocks.apiUser.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      actorId: "00000000-0000-4000-8000-000000000001",
      email: "planner@example.com",
      displayName: "Budget planner",
      role: "viewer",
    });

    const tooManyColumns = await POST(request({
      origin: "http://localhost",
      body: {
        ...PAYLOAD,
        columns: Array.from({ length: 101 }, (_, index) => ({
          key: `column-${index}`,
          header: `Column ${index}`,
          type: "text",
        })),
      },
    }));
    expect(tooManyColumns.status).toBe(400);

    const longCell = await POST(request({
      origin: "http://localhost",
      body: { ...PAYLOAD, rows: [{ person: "x".repeat(32_768) }] },
    }));
    expect(longCell.status).toBe(400);
  });
});
