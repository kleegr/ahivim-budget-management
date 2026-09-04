import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import {
  listGlobalPortalRoleAssignments,
  setGlobalPortalRoleAssignment,
  setIndividualPortalAssignment,
} from "@/lib/manage/portal-identities";

const USER = "00000000-0000-4000-8000-000000000001";
const INDIVIDUAL = "00000000-0000-4000-8000-000000000002";
const ACTOR = "00000000-0000-4000-8000-000000000003";

function transactionalPool(
  poolRows: unknown[],
  clientResult: (sql: string) => unknown[] = () => [],
): { pool: PgLikePool; clientQuery: ReturnType<typeof vi.fn> } {
  const clientQuery = vi.fn(async (sql: string) => ({ rows: clientResult(sql) }));
  const client = { query: clientQuery, release: vi.fn() };
  const pool = {
    query: vi.fn(async () => ({ rows: poolRows })),
    connect: vi.fn(async () => client),
  } as unknown as PgLikePool;
  return { pool, clientQuery };
}

describe("portal identity management", () => {
  it("returns saved global capability overrides for an effective-access preview", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{
        user_id: USER,
        display_name: "Portal Parent",
        email: "parent@example.test",
        portal_role: "parent",
        is_active: true,
        capability_grants: [
          "financials.self.billed_totals.read",
          "not-a-real-capability",
        ],
        capability_denials: ["schedules.self.read"],
        updated_at: "2026-09-04T12:00:00.000Z",
      }] })),
      connect: vi.fn(),
    } as unknown as PgLikePool;

    await expect(listGlobalPortalRoleAssignments(pool)).resolves.toEqual([{
      userId: USER,
      displayName: "Portal Parent",
      email: "parent@example.test",
      role: "parent",
      isActive: true,
      capabilityGrants: ["financials.self.billed_totals.read"],
      capabilityDenials: ["schedules.self.read"],
      updatedAt: "2026-09-04T12:00:00.000Z",
    }]);
  });

  it("does not activate a portal role as a side effect of a subject link", async () => {
    const { pool, clientQuery } = transactionalPool([], (sql) =>
      sql.includes("SELECT EXISTS") ? [{ user_exists: true, person_exists: true }] : []);

    const result = await setIndividualPortalAssignment(pool, {
      userId: USER,
      individualId: INDIVIDUAL,
      relationship: "guardian",
    }, ACTOR);

    expect(result.ok).toBe(true);
    const sql = clientQuery.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("INSERT INTO user_individual_relationships");
    expect(sql).not.toContain("INSERT INTO user_portal_roles");
  });

  it("prevents concurrent administration from removing the final owner", async () => {
    const { pool, clientQuery } = transactionalPool(
      [],
      (sql) => sql.includes("FROM users")
        ? [{ id: USER }]
        : sql.includes("active_owner_count")
          ? [{ active_owner_count: 0 }]
          : [],
    );

    const result = await setGlobalPortalRoleAssignment(pool, {
      userId: USER,
      role: "owner",
      isActive: false,
    }, ACTOR);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes("LOCK TABLE user_portal_roles"))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes("INSERT INTO user_portal_roles"))).toBe(false);
  });
});
