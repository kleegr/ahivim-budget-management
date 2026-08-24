import { describe, expect, it, vi } from "vitest";
import { summarizeSettlementRows } from "@/lib/data/settlements";
import type { PgLikePool } from "@/lib/import/commit";
import { settlementApplicationDate } from "@/lib/manage/settlement-freshness";
import {
  applySettlementCredit,
  directSettlementCheckIdentity,
  recordObligationPayment,
  refreshSettlementObligations,
  resolveNumberedDirectCheckDates,
  settlementRefreshBlockingIssueMessage,
  shouldPreserveEndedIndividualPeriod,
} from "@/lib/manage/settlements";

describe("settlement source identity", () => {
  it("distinguishes reused check numbers by check date", () => {
    const first = directSettlementCheckIdentity({
      checkNumber: "CHK-100",
      checkDate: "2026-01-15",
      periodBegin: "2026-01-01",
      periodEnd: "2026-01-14",
    });
    const second = directSettlementCheckIdentity({
      checkNumber: "CHK-100",
      checkDate: "2026-01-31",
      periodBegin: "2026-01-15",
      periodEnd: "2026-01-30",
    });

    expect(first).toBe("check:CHK-100:date:2026-01-15");
    expect(second).toBe("check:CHK-100:date:2026-01-31");
    expect(first).not.toBe(second);
  });

  it("keeps partially dated lines on one check and blocks ambiguous reused numbers", () => {
    const base = {
      employee_id: "00000000-0000-4000-8000-000000000001",
      check_number: "CHK-300",
      payment_recipient: "employee" as const,
      deal_id: "00000000-0000-4000-8000-000000000010",
    };
    const resolved = resolveNumberedDirectCheckDates([
      { ...base, id: "line-1", check_date: "2026-03-15" },
      { ...base, id: "line-2", check_date: null },
    ]);
    expect(resolved.inferredCheckDates.get("line-2")).toBe("2026-03-15");
    expect(resolved.ambiguousCheckCount).toBe(0);

    const ambiguous = resolveNumberedDirectCheckDates([
      { ...base, id: "line-1", check_date: "2026-03-15" },
      { ...base, id: "line-2", check_date: "2026-04-15" },
      { ...base, id: "line-3", check_date: null },
    ]);
    expect(ambiguous.ambiguousCheckCount).toBe(1);
    expect([...ambiguous.ambiguousTransactionIds].sort()).toEqual(["line-1", "line-2", "line-3"]);
  });

  it("groups line items from the same check and falls back to pay-period dates", () => {
    const sameCheck = {
      checkNumber: " CHK-200 ",
      checkDate: "2026-02-15",
      periodBegin: "2026-02-01",
      periodEnd: "2026-02-14",
    };
    expect(directSettlementCheckIdentity(sameCheck)).toBe(
      directSettlementCheckIdentity({ ...sameCheck, periodBegin: null, periodEnd: null }),
    );
    expect(directSettlementCheckIdentity({
      checkNumber: null,
      checkDate: "2026-02-15",
      periodBegin: "2026-02-01",
      periodEnd: "2026-02-14",
    })).toBe("period:2026-02-01:2026-02-14");
    expect(directSettlementCheckIdentity({
      checkNumber: null,
      checkDate: null,
      periodBegin: null,
      periodEnd: null,
    })).toBeNull();
  });
});

describe("settlement lifecycle and summaries", () => {
  it("preserves an individual period that ended today or earlier", () => {
    expect(shouldPreserveEndedIndividualPeriod("2026-08-23", "2026-08-24")).toBe(true);
    expect(shouldPreserveEndedIndividualPeriod("2026-08-24", "2026-08-24")).toBe(true);
    expect(shouldPreserveEndedIndividualPeriod("2026-08-25", "2026-08-24")).toBe(false);
    expect(shouldPreserveEndedIndividualPeriod(null, "2026-08-24")).toBe(false);
  });

  it("counts void rows without including their money in dashboard totals", () => {
    const summary = summarizeSettlementRows([
      {
        state: "open",
        direction: "payable",
        balance: "100.0000",
        originalAmount: "100.0000",
        appliedAmount: "0.0000",
      },
      {
        state: "partial",
        direction: "receivable",
        balance: "40.0000",
        originalAmount: "75.0000",
        appliedAmount: "35.0000",
      },
      {
        state: "credit",
        direction: "reserve",
        balance: "-5.0000",
        originalAmount: "20.0000",
        appliedAmount: "25.0000",
      },
      {
        state: "void",
        direction: "payable",
        balance: "900.0000",
        originalAmount: "900.0000",
        appliedAmount: "0.0000",
      },
    ]);

    expect(summary).toEqual({
      openCount: 1,
      partialCount: 1,
      settledCount: 0,
      creditCount: 1,
      voidCount: 1,
      agencyOwes: "100.0000",
      employeesOwe: "40.0000",
      reservesToSetAside: "0.0000",
      credits: "5.0000",
      originalTotal: "195.0000",
      appliedTotal: "60.0000",
    });
  });
});

describe("settlement refresh certification", () => {
  const clean = {
    skippedMissingCheckIdentity: 0,
    skippedMissingNet: 0,
    skippedInconsistentNet: 0,
    skippedInconsistentCheck: 0,
    skippedMissingBase: 0,
    skippedUnknownRecipient: 0,
  };

  it("keeps the ledger blocked for unsafe source rows but not for a missing deal", () => {
    const missingDealOnly = { ...clean, skippedNoDeal: 3 };
    expect(settlementRefreshBlockingIssueMessage(clean)).toBeNull();
    expect(settlementRefreshBlockingIssueMessage(missingDealOnly)).toBeNull();
    expect(settlementRefreshBlockingIssueMessage({
      ...clean,
      skippedMissingNet: 2,
      skippedUnknownRecipient: 1,
    })).toBe(
      "Settlement refresh is blocked by source issues: 2 missing whole-check net pay; 1 unknown payment recipient. Correct them and refresh again.",
    );
  });

  it("does not certify a full refresh that skips a direct check with no net pay", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM settlement_ledger_state")) {
          return {
            rows: [{
              source_version: "2",
              refreshed_version: "1",
              dirty_since: "2026-08-24T00:00:00.000Z",
              last_refreshed_at: null,
              last_refresh_error: null,
            }],
          };
        }
        if (sql.includes("FROM payroll_transactions t")) {
          return {
            rows: [{
              id: "00000000-0000-4000-8000-000000000001",
              employee_id: "00000000-0000-4000-8000-000000000002",
              employee_name: "Test Employee",
              check_number: "CHK-1",
              check_date: "2026-08-15",
              period_begin: "2026-08-01",
              period_end: "2026-08-14",
              effective_date: "2026-08-15",
              payment_recipient: "employee",
              billed_amount: "500",
              base_amount: "400",
              total_net_pay: null,
              deal_id: "00000000-0000-4000-8000-000000000003",
              deal_revision: 1,
              direct_rule: "giveback_percent",
              direct_percent: "0.10",
              agency_cut_percent: "0.20",
            }],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    } as unknown as PgLikePool;

    const result = await refreshSettlementObligations(pool, {}, null);

    expect(result).toMatchObject({ ok: true, data: { skippedMissingNet: 1 } });
    expect(statements.some((sql) => sql.includes("WHEN source_version = refreshed_version"))).toBe(true);
    expect(statements.some((sql) => sql.includes("SET refreshed_version = source_version"))).toBe(false);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("blocks a payment before reading or changing an obligation while the ledger is dirty", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM settlement_ledger_state")) {
          return {
            rows: [{
              source_version: "7",
              refreshed_version: "6",
              dirty_since: "2026-08-24T00:00:00.000Z",
              last_refreshed_at: "2026-08-23T00:00:00.000Z",
              last_refresh_error: null,
            }],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    } as unknown as PgLikePool;

    const result = await recordObligationPayment(pool, {
      obligationId: "00000000-0000-4000-8000-000000000001",
      amount: "10",
      occurredOn: "2026-08-24",
      operationKey: "00000000-0000-4000-9000-000000000001",
    }, null);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(statements.some((sql) => sql.includes("FROM settlement_obligations"))).toBe(false);
    expect(statements.some((sql) => sql.includes("INSERT INTO settlement_events"))).toBe(false);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("blocks a payment after the ledger's certified application date", async () => {
    const statements: string[] = [];
    const today = settlementApplicationDate();
    const yesterday = new Date(`${today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM settlement_ledger_state")) {
          return {
            rows: [{
              source_version: "7",
              refreshed_version: "7",
              dirty_since: null,
              last_refreshed_at: yesterday.toISOString(),
              refreshed_for_date: yesterday.toISOString().slice(0, 10),
              last_refresh_error: null,
            }],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    } as unknown as PgLikePool;

    const result = await recordObligationPayment(pool, {
      obligationId: "00000000-0000-4000-8000-000000000001",
      amount: "10",
      occurredOn: today,
      operationKey: "00000000-0000-4000-9000-000000000001",
    }, null);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(statements.some((sql) => sql.includes("FROM settlement_obligations"))).toBe(false);
    expect(statements.some((sql) => sql.includes("INSERT INTO settlement_events"))).toBe(false);
  });

  it("rejects amounts that round to zero before opening a transaction", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => {
        throw new Error("validation must happen before a database transaction");
      }),
    } as unknown as PgLikePool;

    const payment = await recordObligationPayment(pool, {
      obligationId: "00000000-0000-4000-8000-000000000001",
      amount: "0.00001",
      occurredOn: "2026-08-24",
      operationKey: "00000000-0000-4000-9000-000000000001",
    }, null);
    const credit = await applySettlementCredit(pool, {
      sourceObligationId: "00000000-0000-4000-8000-000000000001",
      targetObligationId: "00000000-0000-4000-8000-000000000002",
      amount: "0.00001",
      occurredOn: "2026-08-24",
      operationKey: "00000000-0000-4000-9000-000000000002",
    }, null);

    expect(payment).toMatchObject({ ok: false, code: "validation" });
    expect(credit).toMatchObject({ ok: false, code: "validation" });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe("settlement refresh serialization", () => {
  it("locks on the transaction client before reading any settlement sources", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const poolQuery = vi.fn(async () => {
      throw new Error("refresh source reads must use the locked transaction client");
    });
    const pool = {
      query: poolQuery,
      connect: vi.fn(async () => client),
    } as unknown as PgLikePool;

    const result = await refreshSettlementObligations(pool, {}, null);

    expect(result).toMatchObject({ ok: true });
    expect(poolQuery).not.toHaveBeenCalled();
    const advisoryLock = statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
    const payrollRead = statements.findIndex((sql) => sql.includes("FROM payroll_transactions t"));
    const strategyRead = statements.findIndex((sql) => sql.includes("FROM calculation_strategies s"));
    expect(advisoryLock).toBeGreaterThan(statements.findIndex((sql) => sql === "BEGIN"));
    expect(payrollRead).toBeGreaterThan(advisoryLock);
    expect(strategyRead).toBeGreaterThan(advisoryLock);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("replaces transaction provenance while an obligation is still unactioned", async () => {
    const employeeId = "00000000-0000-4000-8000-000000000001";
    const dealId = "00000000-0000-4000-8000-000000000002";
    const transactionId = "00000000-0000-4000-8000-000000000003";
    const obligationId = "00000000-0000-4000-8000-000000000004";
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("FROM settlement_ledger_state")) {
          return {
            rows: [{
              source_version: "4",
              refreshed_version: "4",
              dirty_since: null,
              last_refreshed_at: null,
              refreshed_for_date: settlementApplicationDate(),
              last_refresh_error: null,
            }],
          };
        }
        if (sql.includes("JOIN employees e ON e.id = t.employee_id") && sql.includes("LEFT JOIN LATERAL")) {
          return {
            rows: [{
              id: transactionId,
              employee_id: employeeId,
              employee_name: "Test Employee",
              check_number: "SYNC-1",
              check_date: "2026-08-15",
              period_begin: "2026-08-01",
              period_end: "2026-08-14",
              effective_date: "2026-08-15",
              payment_recipient: "employee",
              billed_amount: "100.0000",
              base_amount: "90.0000",
              total_net_pay: "100.0000",
              deal_id: dealId,
              deal_revision: 1,
              direct_rule: "giveback_percent",
              direct_percent: "0.100000",
              agency_cut_percent: "0.000000",
            }],
          };
        }
        if (sql.includes("SELECT o.id, o.original_amount::text") && sql.includes("o.source_key = $1")) {
          return {
            rows: [{
              id: obligationId,
              original_amount: "9.0000",
              direction: "receivable",
              status: "active",
              event_count: "0",
              applied_amount: "0.0000",
            }],
          };
        }
        if (sql.includes("count(*)::text AS event_count")) {
          return { rows: [{ event_count: "0", applied_amount: "0.0000" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    } as unknown as PgLikePool;

    const result = await refreshSettlementObligations(pool, { employeeId }, null);

    expect(result).toMatchObject({ ok: true, data: { updated: 1 } });
    const deleteCall = calls.find(({ sql }) =>
      sql.includes("DELETE FROM settlement_obligation_transactions"),
    );
    expect(deleteCall?.params).toEqual([obligationId, [transactionId]]);
    const upsertCall = calls.find(({ sql }) =>
      sql.includes("INSERT INTO settlement_obligation_transactions"),
    );
    expect(upsertCall?.params).toEqual([obligationId, transactionId, null, null]);
  });
});
