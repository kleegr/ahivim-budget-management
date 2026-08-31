import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.AUTH_SECRET = "view-as-session-test-secret";
  return { cookies: vi.fn() };
});
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

import {
  readImpersonation,
  readSession,
  signImpersonation,
  signSession,
} from "@/lib/auth/crypto";
import {
  IMPERSONATION_COOKIE,
  SESSION_COOKIE,
  createImpersonationSession,
  impersonationAuthorityIsValid,
  restoreOwnerSession,
} from "@/lib/auth/session";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";
const owner = { id: OWNER_ID, role: "admin", displayName: "Owner" };
const target = { id: TARGET_ID, role: "viewer", displayName: "Planner" };

describe("view-as session cookies", () => {
  const set = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue({ set, get: vi.fn() });
  });

  it("uses a signature scope that cannot be exchanged with a normal session", () => {
    const exp = Date.now() + 60_000;
    const session = signSession({ userId: OWNER_ID, role: "admin", displayName: "Owner", exp });
    const impersonation = signImpersonation({
      ownerUserId: OWNER_ID,
      targetUserId: TARGET_ID,
      ownerSessionExpiresAt: exp,
      exp,
    });

    expect(readImpersonation(session)).toBeNull();
    expect(readSession(impersonation)).toBeNull();
    expect(readImpersonation(`${impersonation.slice(0, -1)}x`)).toBeNull();
  });

  it("requires the signed target and a currently active administrator owner", () => {
    const exp = Date.now() + 60_000;
    const proof = {
      ownerUserId: OWNER_ID,
      targetUserId: TARGET_ID,
      ownerSessionExpiresAt: exp,
      exp,
    };
    const targetSession = {
      userId: TARGET_ID,
      role: "viewer",
      displayName: "Planner",
      impersonatorUserId: OWNER_ID,
      exp,
    };

    expect(impersonationAuthorityIsValid(proof, targetSession, {
      id: OWNER_ID,
      role: "admin",
      isActive: true,
    })).toBe(true);
    expect(impersonationAuthorityIsValid(proof, {
      ...targetSession,
      userId: OWNER_ID,
    }, { id: OWNER_ID, role: "admin", isActive: true })).toBe(false);
    expect(impersonationAuthorityIsValid(proof, targetSession, {
      id: OWNER_ID,
      role: "manager",
      isActive: true,
    })).toBe(false);
    expect(impersonationAuthorityIsValid(proof, targetSession, {
      id: OWNER_ID,
      role: "admin",
      isActive: false,
    })).toBe(false);
  });

  it("sets HttpOnly same-site cookies and limits the target to the short proof", async () => {
    const ownerExpiry = Date.now() + 4 * 60 * 60 * 1000;
    const proof = await createImpersonationSession(owner, target, ownerExpiry);

    expect(proof.ownerSessionExpiresAt).toBe(ownerExpiry);
    expect(proof.exp).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
    expect(set).toHaveBeenCalledTimes(2);

    const returnWrite = set.mock.calls.find(([name]) => name === IMPERSONATION_COOKIE);
    const targetWrite = set.mock.calls.find(([name]) => name === SESSION_COOKIE);
    expect(returnWrite?.[2]).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(targetWrite?.[2]).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(readImpersonation(returnWrite?.[1])).toMatchObject({
      ownerUserId: OWNER_ID,
      targetUserId: TARGET_ID,
    });
    expect(readSession(targetWrite?.[1])).toMatchObject({
      userId: TARGET_ID,
      role: "viewer",
      impersonatorUserId: OWNER_ID,
      exp: proof.exp,
    });
  });

  it("restores the owner at the original expiry and clears the return proof", async () => {
    const ownerExpiry = Date.now() + 2 * 60 * 60 * 1000;
    const proof = {
      ownerUserId: OWNER_ID,
      targetUserId: TARGET_ID,
      ownerSessionExpiresAt: ownerExpiry,
      exp: Date.now() + 30 * 60 * 1000,
    };

    expect(await restoreOwnerSession(owner, proof)).toBe(true);
    const ownerWrite = set.mock.calls.find(([name, value]) => (
      name === SESSION_COOKIE && value !== ""
    ));
    const clearWrite = set.mock.calls.find(([name, value]) => (
      name === IMPERSONATION_COOKIE && value === ""
    ));
    expect(readSession(ownerWrite?.[1])).toMatchObject({
      userId: OWNER_ID,
      exp: ownerExpiry,
    });
    expect(clearWrite?.[2]).toMatchObject({ maxAge: 0, httpOnly: true });
  });
});
