import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  listGridViews: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/manage/grid-views", () => ({
  listGridViews: mocks.listGridViews,
  saveGridView: vi.fn(),
}));

import { GET } from "@/app/api/grid-views/route";

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
});
