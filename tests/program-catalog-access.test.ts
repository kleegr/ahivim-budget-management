import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  resolveAccessScope: vi.fn(),
  getPool: vi.fn(),
  listPrograms: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/auth/access", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/access")>(),
  resolveAccessScope: mocks.resolveAccessScope,
}));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/data/app-queries", () => ({ listPrograms: mocks.listPrograms }));

import { GET } from "@/app/api/programs/route";

describe("program catalog server access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiUser.mockResolvedValue({ id: "portal-user", role: "viewer" });
    mocks.getPool.mockReturnValue({ query: vi.fn() });
    mocks.listPrograms.mockResolvedValue([]);
  });

  it("does not let a portal-only account enumerate the internal catalog", async () => {
    mocks.resolveAccessScope.mockResolvedValue({
      full: false,
      canSeeHours: false,
      canSeeMoney: false,
    });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.listPrograms).not.toHaveBeenCalled();
  });

  it("keeps the catalog available to an hours-only planner", async () => {
    mocks.resolveAccessScope.mockResolvedValue({
      full: false,
      canSeeHours: true,
      canSeeMoney: false,
      canSeeBilledAmounts: false,
      canSeeEmployeeAmounts: false,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.listPrograms).toHaveBeenCalledOnce();
  });
});
