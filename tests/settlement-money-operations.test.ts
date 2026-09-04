import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { settlementApplicationDate } from "@/lib/manage/settlement-freshness";
import { correctSettlementEvent, refundSettlementCredit } from "@/lib/manage/settlements";

const OBLIGATION = "00000000-0000-4000-8000-000000000001";
const EVENT = "00000000-0000-4000-8000-000000000002";
const ACTOR = "00000000-0000-4000-8000-000000000003";
const OPERATION = "00000000-0000-4000-9000-000000000004";
const BATCH = "00000000-0000-4000-8000-000000000005";
const REVERSAL = "00000000-0000-4000-8000-000000000006";
const REPLACEMENT = "00000000-0000-4000-8000-000000000007";

function cleanFreshness() {
  return {
    rows: [{
      source_version: "8",
      refreshed_version: "8",
      dirty_since: null,
      last_refreshed_at: new Date().toISOString(),
      refreshed_for_date: settlementApplicationDate(),
      last_refresh_error: null,
    }],
  };
}

describe("append-only settlement money operations", () => {
  it("refunds only an available credit by appending a negative adjustment", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM settlement_batches")) return { rows: [] };
        if (sql.includes("FROM settlement_ledger_state")) return cleanFreshness();
        if (sql.includes("FROM settlement_obligations o")) {
          return { rows: [{
            id: OBLIGATION,
            employee_id: ACTOR,
            individual_id: null,
            direction: "receivable",
            original_amount: "100.0000",
            status: "active",
          }] };
        }
        if (sql.includes("GROUP BY settlement_obligation_id")) {
          return { rows: [{ settlement_obligation_id: OBLIGATION, applied_amount: "150.0000" }] };
        }
        if (sql.includes("INSERT INTO settlement_batches")) return { rows: [{ id: BATCH }] };
        if (sql.includes("INSERT INTO settlement_events")) return { rows: [{ id: EVENT }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as PgLikePool;

    const result = await refundSettlementCredit(pool, {
      obligationId: OBLIGATION,
      amount: "25",
      occurredOn: "2026-08-24",
      operationKey: OPERATION,
      reference: "refund-1",
      note: "Returned overpayment",
    }, ACTOR);

    expect(result).toEqual({ ok: true, data: { batchId: BATCH, eventIds: [EVENT] } });
    const inserted = calls.find(({ sql }) => sql.includes("INSERT INTO settlement_events"));
    expect(inserted?.sql).toContain("'adjustment'");
    expect(inserted?.params).toContain("-25.0000");
    expect(calls.some(({ sql }) => /^\s*(UPDATE|DELETE)\b/i.test(sql))).toBe(false);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("rejects a refund larger than the credit without appending activity", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM settlement_batches")) return { rows: [] };
        if (sql.includes("FROM settlement_ledger_state")) return cleanFreshness();
        if (sql.includes("FROM settlement_obligations o")) {
          return { rows: [{
            id: OBLIGATION,
            employee_id: ACTOR,
            individual_id: null,
            direction: "receivable",
            original_amount: "100.0000",
            status: "active",
          }] };
        }
        if (sql.includes("GROUP BY settlement_obligation_id")) {
          return { rows: [{ settlement_obligation_id: OBLIGATION, applied_amount: "125.0000" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as PgLikePool;

    const result = await refundSettlementCredit(pool, {
      obligationId: OBLIGATION,
      amount: "25.01",
      occurredOn: "2026-08-24",
      operationKey: OPERATION,
    }, ACTOR);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(calls.some(({ sql }) => sql.includes("INSERT INTO settlement_events"))).toBe(false);
  });

  it("corrects a payment atomically with an exact reversal and replacement", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    let eventInsert = 0;
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM settlement_batches")) return { rows: [] };
        if (sql.includes("FROM settlement_ledger_state")) return cleanFreshness();
        if (sql.includes("JOIN settlement_obligations o ON")) {
          return { rows: [{
            id: EVENT,
            settlement_obligation_id: OBLIGATION,
            employee_id: ACTOR,
            individual_id: null,
            event_type: "payment",
            amount: "150.0000",
            occurred_on: "2026-08-20",
            reference: "wrong-ref",
            note: "wrong amount",
            obligation_status: "active",
          }] };
        }
        if (sql.includes("reversal_of_event_id = $1")) return { rows: [] };
        if (sql.includes("INSERT INTO settlement_batches")) return { rows: [{ id: BATCH }] };
        if (sql.includes("INSERT INTO settlement_events")) {
          eventInsert++;
          return { rows: [{ id: eventInsert === 1 ? REVERSAL : REPLACEMENT }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as PgLikePool;

    const result = await correctSettlementEvent(pool, EVENT, {
      amount: "120",
      occurredOn: "2026-08-21",
      operationKey: OPERATION,
      reference: "correct-ref",
      note: "correct amount",
      reason: "Bank confirmation showed a different amount.",
    }, ACTOR);

    expect(result).toEqual({
      ok: true,
      data: { batchId: BATCH, eventIds: [REVERSAL, REPLACEMENT].sort() },
    });
    const inserts = calls.filter(({ sql }) => sql.includes("INSERT INTO settlement_events"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.sql).toContain("'reversal'");
    expect(inserts[0]?.params).toContain("-150.0000");
    expect(inserts[0]?.params).toContain(EVENT);
    expect(inserts[1]?.params).toContain("payment");
    expect(inserts[1]?.params).toContain("120.0000");
    expect(inserts[1]?.params).toContain("2026-08-21");
    expect(calls.some(({ sql }) => /^\s*(UPDATE|DELETE)\b/i.test(sql))).toBe(false);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("requires credit transfers to be reversed instead of partially corrected", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM settlement_batches")) return { rows: [] };
        if (sql.includes("FROM settlement_ledger_state")) return cleanFreshness();
        if (sql.includes("JOIN settlement_obligations o ON")) {
          return { rows: [{
            id: EVENT,
            settlement_obligation_id: OBLIGATION,
            employee_id: ACTOR,
            individual_id: null,
            event_type: "credit",
            amount: "20.0000",
            occurred_on: "2026-08-20",
            reference: null,
            note: null,
            obligation_status: "active",
          }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as PgLikePool;

    const result = await correctSettlementEvent(pool, EVENT, {
      amount: "10",
      occurredOn: "2026-08-21",
      operationKey: OPERATION,
      reason: "Wrong transfer",
    }, ACTOR);

    expect(result).toMatchObject({ ok: false, code: "validation" });
    expect(calls.some(({ sql }) => sql.includes("INSERT INTO settlement_events"))).toBe(false);
  });
});
