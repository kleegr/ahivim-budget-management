import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createProgramSetup } from "@/lib/manage/programs";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";

const PROGRAM_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "COMMUNITY_ACTIVITY",
  name: "Community Activity",
  is_group_capable: true,
  is_active: true,
  notes: null,
  archived_at: null,
};

function setupPool(options: { failRate?: boolean } = {}) {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    if (options.failRate && sql.includes("INSERT INTO program_rate_schedules")) {
      throw new Error("rate write failed");
    }
    if (sql.includes("SELECT id FROM programs")) return { rows: [] };
    if (sql.includes("INSERT INTO programs")) return { rows: [PROGRAM_ROW] };
    return { rows: [] };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PgLikeClient;
  const connect = vi.fn(async () => client);
  return {
    pool: { query: vi.fn(), connect } as unknown as PgLikePool,
    statements,
    connect,
    release,
  };
}

describe("guided program setup", () => {
  it("creates the program, common rules, and starting rate in one transaction", async () => {
    const db = setupPool();
    const result = await createProgramSetup(db.pool, {
      name: "Community Activity",
      serviceCategory: "group_service",
      requiredAuthType: "hours",
      paymentRecipient: "agency",
      consumptionSource: "payroll",
      groupsAllowed: true,
      rateScope: "per_group",
      effectiveFrom: "2026-09-01",
      agencyRate: "25",
      internalRate: "21",
    }, "22222222-2222-4222-8222-222222222222");

    expect(result).toMatchObject({ ok: true, data: { code: "COMMUNITY_ACTIVITY" } });
    expect(db.statements[0]?.sql).toBe("BEGIN");
    expect(db.statements.some(({ sql }) => sql.includes("required_auth_type") && sql.includes("payment_recipient"))).toBe(true);
    expect(db.statements.some(({ sql }) => sql.includes("INSERT INTO program_rate_schedules"))).toBe(true);
    expect(db.statements.at(-1)?.sql).toBe("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("does not connect when a starting funder rate is missing its employee base", async () => {
    const db = setupPool();
    const result = await createProgramSetup(db.pool, {
      name: "New program",
      agencyRate: "25",
      effectiveFrom: "2026-09-01",
    }, null);

    expect(result).toMatchObject({ ok: false, code: "validation" });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rolls back the whole setup if the starting rate cannot be saved", async () => {
    const db = setupPool({ failRate: true });
    await expect(createProgramSetup(db.pool, {
      name: "Community Activity",
      effectiveFrom: "2026-09-01",
      agencyRate: "25",
      internalRate: "21",
    }, null)).rejects.toThrow("rate write failed");

    expect(db.statements.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    expect(db.statements.some(({ sql }) => sql === "COMMIT")).toBe(false);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("keeps common choices visible and rare rules collapsed in the UI", () => {
    const source = readFileSync("src/components/settings/program-rules.tsx", "utf8");
    const route = readFileSync("src/app/api/programs/route.ts", "utf8");

    expect(source).toContain("Budget is measured in");
    expect(source).toContain("Payment goes to");
    expect(source).toContain("Usage comes from");
    expect(source).toContain("Advanced settings");
    expect(source).toContain("Advanced rules");
    expect(source).toContain("aria-busy={busy}");
    expect(route).toContain("body.guidedSetup === true");
    expect(route).toContain("createProgramSetup");
  });
});
