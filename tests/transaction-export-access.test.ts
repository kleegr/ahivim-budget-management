import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fullAccess } from "@/lib/auth/access";
const mocks = vi.hoisted(() => ({ apiUser: vi.fn(), getPool: vi.fn(), resolveAccessScope: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/auth/access", async (original) => ({ ...await original<typeof import("@/lib/auth/access")>(), resolveAccessScope: mocks.resolveAccessScope }));
import { POST } from "@/app/api/transactions/export/route";
const request = (key: string) => new NextRequest("http://localhost/api/transactions/export", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ columns: [{ key, header: key, type: "text" }], rows: [{ [key]: "Synthetic value" }] }) });
describe("transaction export field boundaries", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.apiUser.mockResolvedValue({ id: "owner", role: "admin" }); mocks.resolveAccessScope.mockResolvedValue(fullAccess("owner", "admin")); });
  it("denies a planner transaction export before rendering any cell", async () => {
    mocks.resolveAccessScope.mockResolvedValue({ ...fullAccess("planner", "viewer"), canSeeTransactions: false });
    expect((await POST(request("hours"))).status).toBe(403);
  });
  it("denies prohibited amounts and completeness metadata even under a forged text type", async () => {
    mocks.resolveAccessScope.mockResolvedValue({ ...fullAccess("limited", "viewer"), canSeeEmployeeAmounts: false, canSeeAgencySpread: false, canSeeCheckNet: false });
    for (const key of ["employeeBase", "employeeBaseCompleteness", "agencySpread", "verifiedNet", "unrecognizedSecret"]) expect((await POST(request(key))).status).toBe(403);
    expect((await POST(request("individual"))).status).toBe(200);
  });
});
