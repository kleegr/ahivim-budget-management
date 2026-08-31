import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";

const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(),
  createUserWithAccessQuery: vi.fn(),
  userAccessConfigFromInput: vi.fn(),
  setGlobalPortalRoleAssignmentQuery: vi.fn(),
  setIndividualPortalAssignmentQuery: vi.fn(),
  setEmployeePortalAssignmentQuery: vi.fn(),
  setAgencyUserAccessQuery: vi.fn(),
  recordChange: vi.fn(),
}));

vi.mock("@/lib/auth/crypto", () => ({ hashPassword: mocks.hashPassword }));
vi.mock("@/lib/auth/users", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/users")>();
  return {
    ...actual,
    createUserWithAccessQuery: mocks.createUserWithAccessQuery,
    userAccessConfigFromInput: mocks.userAccessConfigFromInput,
  };
});
vi.mock("@/lib/manage/portal-identities", () => ({
  setGlobalPortalRoleAssignmentQuery: mocks.setGlobalPortalRoleAssignmentQuery,
  setIndividualPortalAssignmentQuery: mocks.setIndividualPortalAssignmentQuery,
  setEmployeePortalAssignmentQuery: mocks.setEmployeePortalAssignmentQuery,
}));
vi.mock("@/lib/manage/agencies", () => ({
  setAgencyUserAccessQuery: mocks.setAgencyUserAccessQuery,
}));
vi.mock("@/lib/manage/audit", () => ({ recordChange: mocks.recordChange }));

import { provisionUser } from "@/lib/auth/provision-user";

const USER = "00000000-0000-4000-8000-000000000001";
const ACTOR = "00000000-0000-4000-8000-000000000002";
const SUBJECT = "00000000-0000-4000-8000-000000000003";

function mockPool() {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 1 }));
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query, release })),
    query: vi.fn(),
  } as unknown as PgLikePool;
  return { pool, query, release };
}

function base(preset: string) {
  return {
    preset,
    displayName: "Portal User",
    email: `${preset}@example.test`,
    password: "temporary password",
  };
}

describe("atomic preset user provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hashPassword.mockResolvedValue("stored-hash");
    mocks.userAccessConfigFromInput.mockReturnValue({});
    mocks.createUserWithAccessQuery.mockResolvedValue({
      ok: true,
      user: {
        id: USER,
        email: "portal@example.test",
        displayName: "Portal User",
        passwordHash: "stored-hash",
        role: "viewer",
        isActive: true,
        lastLoginAt: null,
        createdAt: "2026-08-31T00:00:00Z",
      },
    });
    const success = { ok: true, data: {} };
    mocks.setGlobalPortalRoleAssignmentQuery.mockResolvedValue(success);
    mocks.setIndividualPortalAssignmentQuery.mockResolvedValue(success);
    mocks.setEmployeePortalAssignmentQuery.mockResolvedValue(success);
    mocks.setAgencyUserAccessQuery.mockResolvedValue(success);
  });

  it("creates Owner with the global owner role before committing", async () => {
    const { pool, query } = mockPool();
    const result = await provisionUser(pool, base("owner"), ACTOR);

    expect(result).toMatchObject({ ok: true, data: { preset: "owner" } });
    expect(mocks.setGlobalPortalRoleAssignmentQuery).toHaveBeenCalledWith(
      expect.anything(),
      { userId: USER, role: "owner", isActive: true },
      ACTOR,
      null,
    );
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
  });

  it("creates both the account role and direct individual relationship", async () => {
    const { pool } = mockPool();
    const result = await provisionUser(pool, {
      ...base("individual_parent"),
      individualId: SUBJECT,
      relationship: "guardian",
    }, ACTOR);

    expect(result.ok).toBe(true);
    expect(mocks.setGlobalPortalRoleAssignmentQuery).toHaveBeenCalledWith(
      expect.anything(),
      { userId: USER, role: "parent", isActive: true },
      ACTOR,
      null,
    );
    expect(mocks.setIndividualPortalAssignmentQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: USER,
        individualId: SUBJECT,
        relationship: "guardian",
        capabilityGrants: [
          "financials.self.billed_totals.read",
          "financials.self.cuts_set_asides.read",
        ],
      }),
      ACTOR,
      null,
    );
  });

  it("maps each agency preset to the requested agency role", async () => {
    for (const [preset, role] of [
      ["agency", "agency"],
      ["agency_scheduler", "scheduler"],
      ["agency_staffing_manager", "staffing_manager"],
      ["agency_collector", "collector"],
    ] as const) {
      vi.clearAllMocks();
      mocks.hashPassword.mockResolvedValue("stored-hash");
      mocks.createUserWithAccessQuery.mockResolvedValue({
        ok: true,
        user: { id: USER, email: "a@example.test", displayName: "A", role: "viewer", isActive: true },
      });
      mocks.setAgencyUserAccessQuery.mockResolvedValue({ ok: true, data: {} });
      const { pool } = mockPool();

      const result = await provisionUser(pool, { ...base(preset), agencyId: SUBJECT }, ACTOR);

      expect(result.ok).toBe(true);
      expect(mocks.setAgencyUserAccessQuery).toHaveBeenCalledWith(
        expect.anything(),
        SUBJECT,
        expect.objectContaining({ userId: USER, role }),
        ACTOR,
        null,
      );
    }
  });

  it("rolls the new login back when a later portal binding fails", async () => {
    const { pool, query, release } = mockPool();
    mocks.setIndividualPortalAssignmentQuery.mockResolvedValue({
      ok: false,
      code: "not_found",
      message: "That individual no longer exists.",
    });

    const result = await provisionUser(pool, {
      ...base("individual_parent"),
      individualId: SUBJECT,
      relationship: "parent",
    }, ACTOR);

    expect(result).toEqual({
      ok: false,
      code: "not_found",
      message: "That individual no longer exists.",
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(mocks.recordChange).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a missing subject before opening a transaction", async () => {
    const { pool } = mockPool();
    const result = await provisionUser(pool, base("employee"), ACTOR);

    expect(result).toMatchObject({ ok: false, code: "validation" });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
