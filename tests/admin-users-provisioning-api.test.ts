import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  provisionUser: vi.fn(),
  createUser: vi.fn(),
  listUsersWithAccess: vi.fn(),
  updateManagedUser: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/auth/provision-user", () => ({ provisionUser: mocks.provisionUser }));
vi.mock("@/lib/auth/users", () => ({
  createUser: mocks.createUser,
  listUsersWithAccess: mocks.listUsersWithAccess,
  updateManagedUser: mocks.updateManagedUser,
}));

import { POST } from "@/app/api/admin/users/route";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const pool = { query: vi.fn(), connect: vi.fn() };

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin preset provisioning API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiUser.mockResolvedValue({ id: ACTOR, role: "admin" });
    mocks.getPool.mockReturnValue(pool);
  });

  it("requires an administrator before provisioning", async () => {
    mocks.apiUser.mockResolvedValue(null);
    const response = await POST(request({ preset: "owner" }));

    expect(response.status).toBe(403);
    expect(mocks.provisionUser).not.toHaveBeenCalled();
  });

  it("passes the preset and its contextual selector to the atomic service", async () => {
    mocks.provisionUser.mockResolvedValue({
      ok: true,
      data: {
        id: "user-id",
        email: "parent@example.test",
        displayName: "Parent",
        role: "viewer",
        isActive: true,
        preset: "individual_parent",
      },
    });
    const response = await POST(request({
      preset: "individual_parent",
      displayName: "Parent",
      email: "parent@example.test",
      password: "temporary password",
      individualId: "00000000-0000-4000-8000-000000000002",
      relationship: "guardian",
    }));

    expect(response.status).toBe(201);
    expect(mocks.provisionUser).toHaveBeenCalledWith(pool, expect.objectContaining({
      preset: "individual_parent",
      individualId: "00000000-0000-4000-8000-000000000002",
      relationship: "guardian",
    }), ACTOR);
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("maps typed provisioning failures to their HTTP status", async () => {
    mocks.provisionUser.mockResolvedValue({
      ok: false,
      code: "conflict",
      message: "An account with that email address already exists.",
    });
    const response = await POST(request({
      preset: "owner",
      email: "owner@example.test",
      password: "temporary password",
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ ok: false, code: "conflict" });
  });

  it("preserves the legacy create branch when no preset is supplied", async () => {
    mocks.createUser.mockResolvedValue({
      ok: true,
      user: {
        id: "legacy-user",
        email: "legacy@example.test",
        displayName: "Legacy",
        role: "viewer",
        isActive: true,
      },
    });
    const response = await POST(request({
      role: "viewer",
      email: "legacy@example.test",
      displayName: "Legacy",
      password: "temporary password",
    }));

    expect(response.status).toBe(201);
    expect(mocks.createUser).toHaveBeenCalledOnce();
    expect(mocks.provisionUser).not.toHaveBeenCalled();
  });
});
