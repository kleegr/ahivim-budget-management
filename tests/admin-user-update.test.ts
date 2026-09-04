import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";

const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(),
  setGlobalPortalRoleAssignmentQuery: vi.fn(),
}));

vi.mock("@/lib/auth/crypto", () => ({
  hashPassword: mocks.hashPassword,
  verifyPassword: vi.fn(),
}));
vi.mock("@/lib/manage/portal-identities", () => ({
  setGlobalPortalRoleAssignmentQuery: mocks.setGlobalPortalRoleAssignmentQuery,
}));

import { updateManagedUser, userAccessConfigFromInput } from "@/lib/auth/users";

const USER = "00000000-0000-4000-8000-000000000001";
const ACTOR = "00000000-0000-4000-8000-000000000002";

function managedPool(input: {
  role: "viewer" | "manager" | "admin";
  isActive?: boolean;
  accountPreset?: string | null;
  hasOwner?: boolean;
  otherAdmins?: number;
}) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    statements.push(sql);
    if (sql.includes("SELECT role, account_preset, is_active FROM users")) {
      const defaultPreset = input.role === "admin"
        ? "owner"
        : input.role === "manager"
          ? "office_manager"
          : "custom_access";
      return {
        rows: [{
          role: input.role,
          account_preset: input.accountPreset === undefined ? defaultPreset : input.accountPreset,
          is_active: input.isActive ?? true,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("active_admin_count")) {
      return { rows: [{ active_admin_count: input.otherAdmins ?? 1 }], rowCount: 1 };
    }
    if (sql.includes("FROM user_portal_roles") && sql.includes("portal_role = 'owner'")) {
      return { rows: input.hasOwner ? [{ is_active: true }] : [], rowCount: input.hasOwner ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query, release })),
    query: vi.fn(),
  } as unknown as PgLikePool;
  return { pool, query, release, statements };
}

describe("atomic administrator account updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hashPassword.mockResolvedValue("new-password-hash");
    mocks.setGlobalPortalRoleAssignmentQuery.mockResolvedValue({
      ok: true,
      data: { userId: USER, role: "owner", isActive: true },
    });
  });

  it("promotes internal and portal Owner authority in the same transaction", async () => {
    const db = managedPool({ role: "viewer" });

    await expect(updateManagedUser(db.pool, USER, {
      role: "admin",
      password: "temporary password",
    }, ACTOR)).resolves.toEqual({ ok: true, data: { id: USER } });

    expect(mocks.hashPassword).toHaveBeenCalledWith("temporary password");
    expect(mocks.setGlobalPortalRoleAssignmentQuery).toHaveBeenCalledWith(
      expect.anything(),
      { userId: USER, role: "owner", isActive: true },
      ACTOR,
      null,
    );
    expect(db.statements.at(-1)).toBe("COMMIT");
  });

  it("revokes portal Owner authority when an Owner is demoted", async () => {
    const db = managedPool({ role: "admin", hasOwner: true, otherAdmins: 1 });

    await expect(updateManagedUser(db.pool, USER, { role: "manager" }, ACTOR))
      .resolves.toEqual({ ok: true, data: { id: USER } });

    expect(mocks.setGlobalPortalRoleAssignmentQuery).toHaveBeenCalledWith(
      expect.anything(),
      { userId: USER, role: "owner", isActive: false },
      ACTOR,
      null,
    );
    expect(db.statements.at(-1)).toBe("COMMIT");
  });

  it("rolls every account change back when Owner synchronization is rejected", async () => {
    const db = managedPool({ role: "admin", hasOwner: true, otherAdmins: 1 });
    mocks.setGlobalPortalRoleAssignmentQuery.mockResolvedValue({
      ok: false,
      code: "conflict",
      message: "At least one active owner account is required.",
    });

    await expect(updateManagedUser(db.pool, USER, {
      role: "manager",
      password: "temporary password",
    }, ACTOR)).resolves.toMatchObject({ ok: false, code: "conflict" });

    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements).not.toContain("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("rejects a short password before opening a transaction", async () => {
    const db = managedPool({ role: "viewer" });

    await expect(updateManagedUser(db.pool, USER, {
      role: "admin",
      password: "short",
    }, ACTOR)).resolves.toMatchObject({ ok: false, code: "validation" });

    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  it("preserves a selected preset while applying adjusted permissions", async () => {
    const db = managedPool({ role: "viewer", accountPreset: "budget_planner" });
    const access = userAccessConfigFromInput({
      accessScope: "scoped",
      canPlan: true,
      canSeeHours: true,
      canSeeBudgets: false,
    }, "viewer");

    await expect(updateManagedUser(db.pool, USER, {
      role: "viewer",
      accountPreset: "budget_planner",
      access,
    }, ACTOR)).resolves.toEqual({ ok: true, data: { id: USER } });

    const identityUpdate = db.query.mock.calls.find(([sql]) =>
      sql.includes("SET role = $2") && sql.includes("account_preset = $4"));
    expect(identityUpdate?.[1]).toEqual([USER, "viewer", true, "budget_planner"]);
  });

  it("rejects a preset whose canonical role does not match the account role", async () => {
    const db = managedPool({ role: "viewer", accountPreset: "custom_access" });

    await expect(updateManagedUser(db.pool, USER, {
      role: "viewer",
      accountPreset: "office_manager",
    }, ACTOR)).resolves.toMatchObject({ ok: false, code: "validation" });

    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements.some((sql) => sql.startsWith("UPDATE users"))).toBe(false);
  });
});
