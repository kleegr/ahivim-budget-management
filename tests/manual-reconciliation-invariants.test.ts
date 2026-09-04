import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { manualMatch } from "@/lib/manage/reconciliation";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const TRANSACTION_ID = "123e4567-e89b-42d3-a456-426614174001";
const INDIVIDUAL_ID = "123e4567-e89b-42d3-a456-426614174002";
const PROGRAM_ID = "123e4567-e89b-42d3-a456-426614174003";

function reconciliationPool(overrides: {
  session?: Partial<{
    id: string;
    program_id: string;
    session_date: string;
    is_group: boolean;
    matched_transaction_id: string | null;
  }>;
  allocations?: Array<{ individual_id: string }>;
  transaction?: Partial<{
    id: string;
    individual_id: string | null;
    program_id: string | null;
    period_begin: string | null;
    period_end: string | null;
  }>;
  claimed?: boolean;
} = {}) {
  const session = {
    id: SESSION_ID,
    program_id: PROGRAM_ID,
    session_date: "2026-08-15",
    is_group: false,
    matched_transaction_id: null,
    ...overrides.session,
  };
  const transaction = {
    id: TRANSACTION_ID,
    individual_id: INDIVIDUAL_ID,
    program_id: PROGRAM_ID,
    period_begin: "2026-08-01",
    period_end: "2026-08-31",
    ...overrides.transaction,
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM scheduled_sessions") && sql.includes("WHERE id = $1") && sql.includes("program_id")) {
      return { rows: [session], rowCount: 1 };
    }
    if (sql.includes("FROM scheduled_allocations")) {
      const rows = overrides.allocations ?? [{ individual_id: INDIVIDUAL_ID }];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM payroll_transactions")) {
      return { rows: [transaction], rowCount: 1 };
    }
    if (sql.includes("WHERE matched_transaction_id = $1")) {
      return overrides.claimed
        ? { rows: [{ id: "123e4567-e89b-42d3-a456-426614174099" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as PgLikePool,
    query,
    client,
  };
}

describe("manual reconciliation invariants", () => {
  it("links a valid same-person, same-program transaction whose period contains the visit", async () => {
    const { pool, query, client } = reconciliationPool();

    await expect(manualMatch(pool, SESSION_ID, TRANSACTION_ID, null, "Reviewed source"))
      .resolves.toEqual({ ok: true, data: { id: SESSION_ID } });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE scheduled_sessions"))).toBe(true);
    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "another individual",
      overrides: { transaction: { individual_id: "123e4567-e89b-42d3-a456-426614174010" } },
      message: "Choose a transaction for this visit's individual and program.",
    },
    {
      label: "another program",
      overrides: { transaction: { program_id: "123e4567-e89b-42d3-a456-426614174011" } },
      message: "Choose a transaction for this visit's individual and program.",
    },
    {
      label: "a period outside the visit date",
      overrides: { transaction: { period_begin: "2026-08-16", period_end: "2026-08-31" } },
      message: "Choose a transaction whose service period includes this visit date.",
    },
  ])("rejects a transaction for $label without mutating", async ({ overrides, message }) => {
    const { pool, query } = reconciliationPool(overrides);

    await expect(manualMatch(pool, SESSION_ID, TRANSACTION_ID, null)).resolves.toEqual({
      ok: false,
      code: "validation",
      message,
    });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE scheduled_sessions"))).toBe(false);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("keeps group visits out of the one-transaction manual match path", async () => {
    const { pool, query } = reconciliationPool({
      session: { is_group: true },
      allocations: [
        { individual_id: INDIVIDUAL_ID },
        { individual_id: "123e4567-e89b-42d3-a456-426614174012" },
      ],
    });

    await expect(manualMatch(pool, SESSION_ID, TRANSACTION_ID, null)).resolves.toMatchObject({
      ok: false,
      code: "validation",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE scheduled_sessions"))).toBe(false);
  });
});
