import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  clearAuthenticationCookies: vi.fn(),
  createImpersonationSession: vi.fn(),
  currentImpersonationSession: vi.fn(),
  currentSession: vi.fn(),
  restoreOwnerSession: vi.fn(),
  findUserById: vi.fn(),
  writeAudit: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  apiUser: mocks.apiUser,
  clearAuthenticationCookies: mocks.clearAuthenticationCookies,
  createImpersonationSession: mocks.createImpersonationSession,
  currentImpersonationSession: mocks.currentImpersonationSession,
  currentSession: mocks.currentSession,
  restoreOwnerSession: mocks.restoreOwnerSession,
}));
vi.mock("@/lib/auth/users", () => ({
  findUserById: mocks.findUserById,
  writeAudit: mocks.writeAudit,
}));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));

import { POST as startImpersonation } from "@/app/api/auth/impersonation/start/route";
import { POST as stopImpersonation } from "@/app/api/auth/impersonation/stop/route";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";
const pool = { query: vi.fn() };
const owner = {
  id: OWNER_ID,
  email: "owner@example.test",
  displayName: "Owner",
  role: "admin",
  isActive: true,
};
const target = {
  id: TARGET_ID,
  email: "planner@example.test",
  displayName: "Planner",
  role: "viewer",
  isActive: true,
};
const originalExpiry = Date.now() + 4 * 60 * 60 * 1000;
const proof = {
  ownerUserId: OWNER_ID,
  targetUserId: TARGET_ID,
  ownerSessionExpiresAt: originalExpiry,
  exp: Date.now() + 30 * 60 * 1000,
};

function jsonRequest(path: string, body: Record<string, unknown> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("owner view-as API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPool.mockReturnValue(pool);
    mocks.apiUser.mockResolvedValue(owner);
    mocks.currentSession.mockResolvedValue({
      userId: OWNER_ID,
      role: "admin",
      displayName: "Owner",
      exp: originalExpiry,
    });
    mocks.currentImpersonationSession.mockResolvedValue(null);
    mocks.findUserById.mockResolvedValue(target);
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.createImpersonationSession.mockResolvedValue(proof);
    mocks.restoreOwnerSession.mockResolvedValue(true);
  });

  it("switches the server session to an active target and audits the owner action", async () => {
    const response = await startImpersonation(jsonRequest(
      "/api/auth/impersonation/start",
      { targetUserId: TARGET_ID },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, redirectTo: "/home" });
    expect(mocks.createImpersonationSession).toHaveBeenCalledWith(
      owner,
      target,
      originalExpiry,
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(pool, expect.objectContaining({
      userId: OWNER_ID,
      action: "user_impersonation_started",
      entityId: TARGET_ID,
    }));
  });

  it("requires an administrator and refuses self, disabled targets, and nesting", async () => {
    mocks.apiUser.mockResolvedValueOnce(null);
    expect((await startImpersonation(jsonRequest(
      "/api/auth/impersonation/start",
      { targetUserId: TARGET_ID },
    ))).status).toBe(403);

    expect((await startImpersonation(jsonRequest(
      "/api/auth/impersonation/start",
      { targetUserId: OWNER_ID },
    ))).status).toBe(400);

    mocks.findUserById.mockResolvedValueOnce({ ...target, isActive: false });
    expect((await startImpersonation(jsonRequest(
      "/api/auth/impersonation/start",
      { targetUserId: TARGET_ID },
    ))).status).toBe(404);

    mocks.currentImpersonationSession.mockResolvedValueOnce(proof);
    expect((await startImpersonation(jsonRequest(
      "/api/auth/impersonation/start",
      { targetUserId: TARGET_ID },
    ))).status).toBe(409);
  });

  it("rejects a cross-origin attempt before changing either session", async () => {
    const response = await startImpersonation(new NextRequest(
      "http://localhost/api/auth/impersonation/start",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "https://outside.example",
        },
        body: JSON.stringify({ targetUserId: TARGET_ID }),
      },
    ));

    expect(response.status).toBe(403);
    expect(mocks.createImpersonationSession).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("restores only the signed owner whose proof matches the effective target", async () => {
    mocks.currentSession.mockResolvedValue({
      userId: TARGET_ID,
      role: "viewer",
      displayName: "Planner",
      impersonatorUserId: OWNER_ID,
      exp: proof.exp,
    });
    mocks.currentImpersonationSession.mockResolvedValue(proof);
    mocks.findUserById.mockResolvedValue(owner);

    const response = await stopImpersonation(jsonRequest("/api/auth/impersonation/stop"));

    expect(response.status).toBe(200);
    expect(mocks.restoreOwnerSession).toHaveBeenCalledWith(owner, proof);
    expect(mocks.writeAudit).toHaveBeenCalledWith(pool, expect.objectContaining({
      userId: OWNER_ID,
      action: "user_impersonation_stopped",
      entityId: TARGET_ID,
    }));
    expect(mocks.clearAuthenticationCookies).not.toHaveBeenCalled();
  });

  it("clears both cookies instead of restoring a mismatched or demoted owner", async () => {
    mocks.currentSession.mockResolvedValue({
      userId: OWNER_ID,
      role: "admin",
      displayName: "Owner",
      exp: proof.exp,
    });
    mocks.currentImpersonationSession.mockResolvedValue(proof);

    expect((await stopImpersonation(jsonRequest("/api/auth/impersonation/stop"))).status)
      .toBe(401);
    expect(mocks.restoreOwnerSession).not.toHaveBeenCalled();
    expect(mocks.clearAuthenticationCookies).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    mocks.getPool.mockReturnValue(pool);
    mocks.currentSession.mockResolvedValue({
      userId: TARGET_ID,
      role: "viewer",
      displayName: "Planner",
      impersonatorUserId: OWNER_ID,
      exp: proof.exp,
    });
    mocks.currentImpersonationSession.mockResolvedValue(proof);
    mocks.findUserById.mockResolvedValue({ ...owner, role: "manager" });

    expect((await stopImpersonation(jsonRequest("/api/auth/impersonation/stop"))).status)
      .toBe(403);
    expect(mocks.restoreOwnerSession).not.toHaveBeenCalled();
    expect(mocks.clearAuthenticationCookies).toHaveBeenCalledOnce();
  });
});
