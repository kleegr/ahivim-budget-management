import { describe, expect, it, vi } from "vitest";
import {
  setUserRoleAndAccess,
  userAccessConfigFromInput,
} from "@/lib/auth/users";
import type { PgLikePool } from "@/lib/import/commit";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000003";

function fakeTransactionalPool(options: {
  existingRole?: string;
  failOn?: (sql: string) => boolean;
} = {}) {
  let committedRole = options.existingRole ?? "manager";
  let pendingRole: string | null = null;
  const release = vi.fn();
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === "BEGIN") {
      pendingRole = committedRole;
      return { rows: [], rowCount: null };
    }
    if (sql === "ROLLBACK") {
      pendingRole = null;
      return { rows: [], rowCount: null };
    }
    if (sql === "COMMIT") {
      if (pendingRole !== null) committedRole = pendingRole;
      pendingRole = null;
      return { rows: [], rowCount: null };
    }
    if (sql.includes("SELECT role FROM users")) {
      return { rows: [{ role: pendingRole ?? committedRole }], rowCount: 1 };
    }
    if (sql.includes("UPDATE users SET role")) {
      pendingRole = String(params?.[0]);
      return { rows: [], rowCount: 1 };
    }
    if (options.failOn?.(sql)) throw new Error("simulated access write failure");
    return { rows: [], rowCount: 1 };
  });
  const poolQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const pool = {
    query: poolQuery,
    connect: vi.fn(async () => ({ query, release })),
  } as unknown as PgLikePool;
  return { pool, query, poolQuery, release, committedRole: () => committedRole };
}

describe("atomic user role and access changes", () => {
  it("demotes trusted staff to locked viewer defaults in the same transaction", async () => {
    const db = fakeTransactionalPool({ existingRole: "manager" });
    const staleFullAccess = userAccessConfigFromInput({}, "manager");

    await expect(
      setUserRoleAndAccess(db.pool, USER_ID, "viewer", staleFullAccess, ACTOR_ID),
    ).resolves.toBe(true);

    const roleUpdate = db.query.mock.calls.find(([sql]) => sql.includes("UPDATE users SET role"));
    const accessUpdate = db.query.mock.calls.find(([sql]) => sql.includes("SET access_scope"));
    expect(roleUpdate?.[1]).toEqual(["viewer", USER_ID]);
    expect(accessUpdate?.[1]).toEqual(["scoped", ...Array(18).fill(false), USER_ID]);
    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.committedRole()).toBe("viewer");
    expect(db.poolQuery).not.toHaveBeenCalled();
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("preserves an explicitly scoped viewer configuration during demotion", async () => {
    const db = fakeTransactionalPool({ existingRole: "admin" });
    const scoped = userAccessConfigFromInput({
      accessScope: "scoped",
      canSeeHours: true,
      canSeeBudgets: true,
      canPlan: true,
      individualIds: [INDIVIDUAL_ID],
    }, "viewer");

    await expect(
      setUserRoleAndAccess(db.pool, USER_ID, "viewer", scoped, ACTOR_ID),
    ).resolves.toBe(true);

    const accessUpdate = db.query.mock.calls.find(([sql]) => sql.includes("SET access_scope"));
    expect(accessUpdate?.[1]).toEqual([
      "scoped",
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      USER_ID,
    ]);
    const individualGrant = db.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO user_individual_access"));
    expect(individualGrant?.[1]).toEqual([USER_ID, [INDIVIDUAL_ID]]);
    expect(db.committedRole()).toBe("viewer");
  });

  it("rolls the role back when any access write fails", async () => {
    const db = fakeTransactionalPool({
      existingRole: "manager",
      failOn: (sql) => sql.includes("INSERT INTO user_individual_access"),
    });
    const scoped = userAccessConfigFromInput({
      accessScope: "scoped",
      canSeeHours: true,
      individualIds: [INDIVIDUAL_ID],
    }, "viewer");

    await expect(
      setUserRoleAndAccess(db.pool, USER_ID, "viewer", scoped, ACTOR_ID),
    ).rejects.toThrow("simulated access write failure");

    expect(db.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(db.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(db.committedRole()).toBe("manager");
    expect(db.release).toHaveBeenCalledOnce();
  });
});
