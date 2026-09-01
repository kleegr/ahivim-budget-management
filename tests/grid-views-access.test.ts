import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  listGridViews: vi.fn(),
  saveGridView: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/manage/grid-views", () => ({
  listGridViews: mocks.listGridViews,
  saveGridView: mocks.saveGridView,
}));

import { GET, POST } from "@/app/api/grid-views/route";

describe("saved grid view visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not expose opaque manager view configs to a viewer", async () => {
    mocks.apiUser.mockResolvedValue({ id: "viewer-1", role: "viewer" });

    const response = await GET(new NextRequest("http://localhost/api/grid-views?grid=transactions"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: [] });
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.listGridViews).not.toHaveBeenCalled();
  });

  it("keeps shared views available to trusted staff", async () => {
    const views = [{ id: "view-1", name: "Payroll", config: { filter: "Employee One" } }];
    const pool = { name: "pool" };
    mocks.apiUser.mockResolvedValue({ id: "manager-1", role: "manager" });
    mocks.getPool.mockReturnValue(pool);
    mocks.listGridViews.mockResolvedValue(views);

    const response = await GET(new NextRequest("http://localhost/api/grid-views?grid=transactions"));

    expect(await response.json()).toEqual({ ok: true, data: views });
    expect(mocks.listGridViews).toHaveBeenCalledWith(pool, "transactions");
  });

  it("does not expose owner dashboard cohorts to another staff profile", async () => {
    mocks.apiUser.mockResolvedValue({ id: "manager-1", role: "manager" });

    const response = await GET(new NextRequest("http://localhost/api/grid-views?grid=owner_dashboard"));

    expect(await response.json()).toEqual({ ok: true, data: [] });
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.listGridViews).not.toHaveBeenCalled();
  });

  it("does not let another staff profile overwrite owner dashboard cohorts", async () => {
    mocks.apiUser.mockResolvedValue({ id: "manager-1", role: "manager" });
    const request = new NextRequest("http://localhost/api/grid-views", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gridKey: "owner_dashboard", name: "Private cohort", config: {} }),
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(mocks.saveGridView).not.toHaveBeenCalled();
  });

  it("normalizes the grid key before enforcing owner-only access", async () => {
    mocks.apiUser.mockResolvedValue({ id: "manager-1", role: "manager" });
    const request = new NextRequest("http://localhost/api/grid-views", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gridKey: "  owner_dashboard  ", name: "Private cohort", config: {} }),
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(mocks.saveGridView).not.toHaveBeenCalled();
  });
});
