import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ user: vi.fn(), scope: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ apiUser: boundary.user }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/auth/access", async (original) => ({
  ...await original<typeof import("@/lib/auth/access")>(), resolveAccessScope: boundary.scope,
}));
import { fullAccess } from "@/lib/auth/access";
import { getHourAuthorizationOperator } from "@/lib/auth/hour-authorization-access";

describe("authorization operator uses the latest authority snapshot", () => {
  beforeEach(() => boundary.user.mockResolvedValue({ id: "manager", role: "manager" }));

  it("retains the current manager's full workflow", async () => {
    boundary.scope.mockResolvedValue(fullAccess("manager", "manager"));
    expect((await getHourAuthorizationOperator())?.mode).toBe("full");
  });

  it("does not retain full writes after a concurrent downgrade", async () => {
    boundary.scope.mockResolvedValue({ ...fullAccess("manager", "viewer"), full: false,
      canPlan: false, canManagePlanning: false, canSeeHours: false, canSeeBudgets: false });
    expect(await getHourAuthorizationOperator()).toBeNull();
  });

  it("denies a concurrently disabled manager", async () => {
    boundary.scope.mockResolvedValue({ ...fullAccess("manager", "manager"), full: false,
      canPlan: false, canManagePlanning: false, canSeeHours: false, canSeeBudgets: false });
    expect(await getHourAuthorizationOperator()).toBeNull();
  });

  it("uses hours-only restrictions after a downgrade to planner", async () => {
    boundary.scope.mockResolvedValue({ ...fullAccess("manager", "viewer"), full: false,
      canSeeMoney: false, canSeeTransactions: false });
    expect((await getHourAuthorizationOperator())?.mode).toBe("hours_only");
  });
});
