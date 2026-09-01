import { describe, expect, it } from "vitest";
import { auditAttributionFor } from "@/lib/auth/audit-attribution";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ID = "00000000-0000-4000-8000-000000000003";

const session = {
  userId: TARGET_ID,
  role: "viewer",
  displayName: "Planner",
  impersonatorUserId: OWNER_ID,
  exp: Date.now() + 60_000,
};
const proof = {
  ownerUserId: OWNER_ID,
  targetUserId: TARGET_ID,
  ownerSessionExpiresAt: Date.now() + 120_000,
  exp: Date.now() + 60_000,
};

describe("audit attribution during owner preview", () => {
  it("records the owner and retains the effective target", () => {
    expect(auditAttributionFor(TARGET_ID, session, proof)).toEqual({
      actorId: OWNER_ID,
      impersonatedUserId: TARGET_ID,
    });
    expect(auditAttributionFor(OWNER_ID, session, proof)).toEqual({
      actorId: OWNER_ID,
      impersonatedUserId: TARGET_ID,
    });
  });

  it("does not rewrite unrelated or unproved actors", () => {
    expect(auditAttributionFor(OTHER_ID, session, proof)).toEqual({
      actorId: OTHER_ID,
      impersonatedUserId: null,
    });
    expect(auditAttributionFor(TARGET_ID, { ...session, impersonatorUserId: undefined }, proof))
      .toEqual({ actorId: TARGET_ID, impersonatedUserId: null });
    expect(auditAttributionFor(TARGET_ID, session, null))
      .toEqual({ actorId: TARGET_ID, impersonatedUserId: null });
  });
});
