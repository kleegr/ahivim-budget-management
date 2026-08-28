import { describe, expect, it, vi } from "vitest";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import {
  createAuthorizationInTransaction,
  reviseAuthorization,
} from "@/lib/manage/authorizations";

const PERIOD_ID = "10000000-0000-4000-8000-000000000001";
const INDIVIDUAL_ID = "20000000-0000-4000-8000-000000000002";
const PROGRAM_ID = "30000000-0000-4000-8000-000000000003";
const AUTH_ID = "40000000-0000-4000-8000-000000000004";
const REVISED_ID = "50000000-0000-4000-8000-000000000005";
const ACTOR_ID = "60000000-0000-4000-8000-000000000006";

interface FakeOptions {
  allowOverride?: boolean;
  programCode?: string;
}

function authorizationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AUTH_ID,
    budget_period_id: PERIOD_ID,
    individual_id: INDIVIDUAL_ID,
    program_id: PROGRAM_ID,
    program_code: "COM_HAB",
    program_name: "Community Habilitation",
    authorized_hours: "100.0000",
    authorized_dollars: null,
    internal_rate: "21.0000",
    agency_rate: "25.0000",
    individual_rate_override: null,
    rate_basis: "hours",
    revision: 1,
    status: "active",
    supersedes_id: null,
    notes: "Original",
    source: "manual",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeCreateClient(options: FakeOptions = {}) {
  let inserted: unknown[] | null = null;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM budget_periods WHERE id")) {
      return {
        rows: [{
          id: PERIOD_ID,
          individual_id: INDIVIDUAL_ID,
          label: "2026",
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          period_type: "custom",
          renewal_date: "2027-01-01",
          status: "active",
          source: "manual",
          notes: null,
        }],
      };
    }
    if (sql.includes("FROM programs p")) {
      return {
        rows: [{
          code: options.programCode ?? "COM_HAB",
          required_auth_type: "hours",
          is_active: true,
          allow_individual_rate_override: options.allowOverride ?? true,
          agency_rate: "25.0000",
          internal_rate: "21.0000",
        }],
      };
    }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.includes("daterange(existing_period.start_date")) return { rows: [] };
    if (sql.includes("SELECT id FROM budget_authorizations") && !sql.includes("FOR UPDATE")) {
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO budget_authorizations")) {
      inserted = params;
      return { rows: [{ id: AUTH_ID }] };
    }
    if (sql.includes("FROM budget_authorizations a JOIN programs")) {
      const values = inserted!;
      return {
        rows: [authorizationRow({
          authorized_hours: values[3],
          internal_rate: values[4],
          agency_rate: values[5],
          individual_rate_override: values[6],
          authorized_dollars: values[8],
          rate_basis: values[9],
          notes: values[10],
          source: values[11],
        })],
      };
    }
    if (sql.includes("INSERT INTO audit_logs")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, release: vi.fn() } as unknown as PgLikeClient & { query: typeof query };
}

describe("authorization catalog rates", () => {
  it("uses separate catalog funder and employee rates and locks before overlap checks", async () => {
    const client = fakeCreateClient();
    const result = await createAuthorizationInTransaction(client, {
      budgetPeriodId: PERIOD_ID,
      programId: PROGRAM_ID,
      authorizedHours: "100",
    }, ACTOR_ID, "New annual authorization");

    expect(result).toMatchObject({
      ok: true,
      data: {
        agencyRate: "25.0000",
        internalRate: "21.0000",
        individualRateOverride: null,
      },
    });
    const statements = client.query.mock.calls.map(([sql]) => sql);
    const lock = statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
    const overlap = statements.findIndex((sql) => sql.includes("daterange(existing_period.start_date"));
    const insert = statements.findIndex((sql) => sql.includes("INSERT INTO budget_authorizations"));
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(overlap);
    expect(overlap).toBeLessThan(insert);
  });

  it("writes allowed individual funder and employee overrides explicitly", async () => {
    const client = fakeCreateClient({ allowOverride: true });
    const result = await createAuthorizationInTransaction(client, {
      budgetPeriodId: PERIOD_ID,
      programId: PROGRAM_ID,
      authorizedHours: "100",
      agencyRate: "26",
      individualRateOverride: "22",
    }, ACTOR_ID);

    expect(result).toMatchObject({
      ok: true,
      data: {
        agencyRate: "26.0000",
        internalRate: "22.0000",
        individualRateOverride: "22.0000",
      },
    });
  });

  it("rejects rate deviations when the catalog disables individual overrides", async () => {
    const client = fakeCreateClient({ allowOverride: false });
    const result = await createAuthorizationInTransaction(client, {
      budgetPeriodId: PERIOD_ID,
      programId: PROGRAM_ID,
      authorizedHours: "100",
      agencyRate: "26",
      individualRateOverride: "22",
    }, ACTOR_ID);

    expect(result).toMatchObject({ ok: false, code: "validation" });
    expect(client.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO budget_authorizations"))).toBe(false);
  });

  it("rejects generic creation for the Classes sole-writer program", async () => {
    const client = fakeCreateClient({ programCode: "CLASSES" });
    const result = await createAuthorizationInTransaction(client, {
      budgetPeriodId: PERIOD_ID,
      programId: PROGRAM_ID,
      authorizedDollars: "1000",
    }, ACTOR_ID);
    expect(result).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("authorization revisions", () => {
  it("supersedes the locked row and carries both effective rates into revision 2", async () => {
    let inserted: unknown[] | null = null;
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("SELECT id FROM budget_authorizations") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: AUTH_ID }] };
      }
      if (sql.includes("FROM budget_authorizations a JOIN programs")) {
        if (params[0] === REVISED_ID && inserted) {
          return { rows: [authorizationRow({
            id: REVISED_ID,
            authorized_hours: inserted[3],
            internal_rate: inserted[4],
            agency_rate: inserted[5],
            individual_rate_override: inserted[6],
            authorized_dollars: inserted[8],
            rate_basis: inserted[9],
            notes: inserted[10],
            revision: inserted[13],
            supersedes_id: inserted[14],
          })] };
        }
        return { rows: [authorizationRow()] };
      }
      if (sql.includes("FROM budget_periods WHERE id")) {
        return { rows: [{
          id: PERIOD_ID,
          individual_id: INDIVIDUAL_ID,
          label: "2026",
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          period_type: "custom",
          renewal_date: "2027-01-01",
          status: "active",
          source: "manual",
          notes: null,
        }] };
      }
      if (sql.includes("FROM programs p")) {
        return { rows: [{
          code: "COM_HAB",
          required_auth_type: "hours",
          is_active: true,
          allow_individual_rate_override: true,
          agency_rate: "25.0000",
          internal_rate: "21.0000",
        }] };
      }
      if (sql.includes("UPDATE budget_authorizations SET status = 'superseded'")) return { rows: [] };
      if (sql.includes("INSERT INTO budget_authorizations")) {
        inserted = params;
        return { rows: [{ id: REVISED_ID }] };
      }
      if (sql.includes("INSERT INTO audit_logs")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const client = { query, release: vi.fn() } as unknown as PgLikeClient & { query: typeof query };
    const pool = { query, connect: vi.fn(async () => client) } as unknown as PgLikePool;

    const result = await reviseAuthorization(pool, AUTH_ID, {
      authorizedHours: "120",
      agencyRate: "26",
      individualRateOverride: "22",
      notes: "Renewed allocation",
    }, ACTOR_ID, "Parent approved revised allowance");

    expect(result).toMatchObject({
      ok: true,
      data: {
        id: REVISED_ID,
        revision: 2,
        supersedesId: AUTH_ID,
        authorizedHours: "120.0000",
        agencyRate: "26.0000",
        internalRate: "22.0000",
        individualRateOverride: "22.0000",
      },
    });
    expect(query.mock.calls.some(([sql]) => sql.includes("FOR UPDATE"))).toBe(true);
  });
});
