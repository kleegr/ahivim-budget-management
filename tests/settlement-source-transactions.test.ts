import { describe, expect, it, vi } from "vitest";
import { fullAccess, type AccessScope } from "@/lib/auth/access";
import {
  listSettlementSourceTransactions,
  resolveSettlementSourceTransactions,
} from "@/lib/data/settlement-source-transactions";
import type { PgLikePool } from "@/lib/import/commit";

const EMPLOYEE = "123e4567-e89b-42d3-a456-426614174000";
const TRANSACTION = "123e4567-e89b-42d3-a456-426614174010";
const SOURCE = `${EMPLOYEE}:check:9001:date:2026-08-15`;

function restrictedScope(): AccessScope {
  return {
    ...fullAccess("viewer-1", "viewer"),
    full: false,
    allIndividuals: false,
    allEmployees: false,
    individualIds: [],
    employeeIds: [EMPLOYEE],
    grantedIndividualIds: [],
    grantedEmployeeIds: [EMPLOYEE],
  };
}

describe("compact settlement transaction sources", () => {
  it("resolves through a parameterized, transaction-scoped query", async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ id: TRANSACTION }] }));
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await expect(resolveSettlementSourceTransactions(pool, restrictedScope(), SOURCE)).resolves.toEqual({
      transactionIds: [TRANSACTION],
      tooLarge: false,
    });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("effective_payment_recipient");
    expect(sql).toContain("t.employee_id = ANY($2::uuid[])");
    expect(sql).toContain("ambiguous_numbered_checks");
    expect(params).toEqual([SOURCE, [EMPLOYEE]]);
  });

  it("rejects malformed or oversized keys without touching the database", async () => {
    const query = vi.fn();
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await expect(resolveSettlementSourceTransactions(pool, fullAccess("admin", "admin"), "bad\nsource"))
      .resolves.toEqual({ transactionIds: [], tooLarge: false });
    await expect(resolveSettlementSourceTransactions(pool, fullAccess("admin", "admin"), "x".repeat(513)))
      .resolves.toEqual({ transactionIds: [], tooLarge: false });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns a bounded result and reports when a source is too large", async () => {
    const rows = Array.from({ length: 10_001 }, (_, index) => ({
      id: `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`,
    }));
    const pool = { query: vi.fn(async () => ({ rows })), connect: vi.fn() } as unknown as PgLikePool;

    const result = await resolveSettlementSourceTransactions(pool, fullAccess("admin", "admin"), SOURCE);
    expect(result.tooLarge).toBe(true);
    expect(result.transactionIds).toHaveLength(10_000);
  });

  it("does not load the ledger when a compact source resolves to no rows", async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }));
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await expect(listSettlementSourceTransactions(
      pool,
      fullAccess("admin", "admin"),
      SOURCE,
    )).resolves.toEqual({ transactionIds: [], tooLarge: false, rows: [] });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("WITH direct_facts AS");
  });
});
