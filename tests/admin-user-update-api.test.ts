import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  listUsers: vi.fn(),
  getUserAccessConfig: vi.fn(),
  userAccessConfigFromInput: vi.fn(),
  updateManagedUser: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/auth/users", () => ({
  accountPresetMatchesRole: (preset: string, role: string) => {
    if (preset === "owner") return role === "admin";
    if (preset === "office_manager") return role === "manager";
    return role === "viewer";
  },
  isRole: (value: string) => ["viewer", "manager", "admin"].includes(value),
  listUsers: mocks.listUsers,
  getUserAccessConfig: mocks.getUserAccessConfig,
  userAccessConfigFromInput: mocks.userAccessConfigFromInput,
  updateManagedUser: mocks.updateManagedUser,
}));

import { PATCH } from "@/app/api/admin/users/[id]/route";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const pool = { query: vi.fn(), connect: vi.fn() };

function request(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/admin/users/${USER}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("atomic administrator user update API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiUser.mockResolvedValue({ id: ACTOR, role: "admin" });
    mocks.getPool.mockReturnValue(pool);
    mocks.listUsers.mockResolvedValue([{
      id: USER,
      role: "viewer",
      accountPreset: "custom_access",
      isActive: true,
    }]);
    mocks.updateManagedUser.mockResolvedValue({ ok: true, data: { id: USER } });
  });

  it("sends role and password through one managed update", async () => {
    const response = await PATCH(request({
      role: "admin",
      password: "temporary password",
    }), { params: Promise.resolve({ id: USER }) });

    expect(response.status).toBe(200);
    expect(mocks.updateManagedUser).toHaveBeenCalledWith(pool, USER, {
      role: "admin",
      accountPreset: undefined,
      access: undefined,
      isActive: undefined,
      password: "temporary password",
    }, ACTOR);
  });

  it("returns a conflict when the atomic service refuses an Owner demotion", async () => {
    mocks.updateManagedUser.mockResolvedValue({
      ok: false,
      code: "conflict",
      message: "At least one active owner account is required.",
    });

    const response = await PATCH(request({ role: "manager" }), {
      params: Promise.resolve({ id: USER }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "conflict",
    });
  });

  it("preserves the selected internal preset with adjusted permissions", async () => {
    const normalized = { accessScope: "scoped", canPlan: true };
    mocks.userAccessConfigFromInput.mockReturnValue(normalized);

    const response = await PATCH(request({
      role: "viewer",
      preset: "budget_planner",
      accessScope: "scoped",
      canPlan: true,
      canSeeBudgets: false,
    }), { params: Promise.resolve({ id: USER }) });

    expect(response.status).toBe(200);
    expect(mocks.updateManagedUser).toHaveBeenCalledWith(pool, USER, {
      role: "viewer",
      accountPreset: "budget_planner",
      access: normalized,
      isActive: undefined,
      password: undefined,
    }, ACTOR);
  });

  it("rejects incompatible or portal-linked preset relabeling", async () => {
    for (const body of [
      { role: "viewer", preset: "office_manager" },
      { role: "viewer", preset: "employee" },
    ]) {
      mocks.updateManagedUser.mockClear();
      const response = await PATCH(request(body), { params: Promise.resolve({ id: USER }) });
      expect(response.status).toBe(400);
      expect(mocks.updateManagedUser).not.toHaveBeenCalled();
    }
  });
});
