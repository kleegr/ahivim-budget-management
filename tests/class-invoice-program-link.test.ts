import { describe, expect, it, vi } from "vitest";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { repairIssuedClassInvoiceProgramLink } from "@/lib/manage/class-invoices";
import { SETTLEMENT_SOURCE_LOCK } from "@/lib/manage/settlement-freshness";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "22222222-2222-4222-8222-222222222222";
const BUDGET_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_BUDGET_ID = "44444444-4444-4444-8444-444444444444";
const PROGRAM_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_PROGRAM_ID = "66666666-6666-4666-8666-666666666666";
const PERIOD_ID = "77777777-7777-4777-8777-777777777777";
const AUTHORIZATION_ID = "88888888-8888-4888-8888-888888888888";
const CONSUME_ID = "99999999-9999-4999-8999-999999999999";
const REVERSE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INDIVIDUAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface ExistingEvent {
  id: string;
  budget_period_id: string;
  individual_id: string;
  program_id: string;
  event_type: "consume" | "reverse";
  service_date: string;
  hours: string;
  amount: string;
  source_id: string;
  reverses_event_id: string | null;
}

interface FixtureOptions {
  invoiceStatus?: "draft" | "issued" | "void";
  invoiceBudgetId?: string;
  budgetStatus?: "active" | "closed";
  budgetProgramId?: string | null;
  budgetPeriodId?: string | null;
  budgetAuthorizationId?: string | null;
  canonicalProgramId?: string | null;
  existingAuthorization?: boolean;
  existingEvents?: ExistingEvent[];
  ledgerMismatch?: boolean;
  updateSucceeded?: boolean;
}

function repairPool(options: FixtureOptions = {}) {
  const calls: Array<{ statement: string; parameters: unknown[] }> = [];
  const invoiceStatus = options.invoiceStatus ?? "issued";
  const budgetStatus = options.budgetStatus ?? "active";
  const canonicalProgramId = options.canonicalProgramId === null
    ? null
    : options.canonicalProgramId ?? PROGRAM_ID;
  const budgetPeriodId = options.budgetPeriodId === undefined ? null : options.budgetPeriodId;
  const budgetAuthorizationId = options.budgetAuthorizationId === undefined
    ? null
    : options.budgetAuthorizationId;
  const client = {
    query: vi.fn(async (statement: string, parameters: unknown[] = []) => {
      calls.push({ statement, parameters });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [] };
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM class_invoices")
          && statement.includes("WHERE id = $1")
          && statement.includes("FOR UPDATE")) {
        return {
          rows: [{
            class_budget_period_id: options.invoiceBudgetId ?? BUDGET_ID,
            status: invoiceStatus,
          }],
        };
      }
      if (statement.includes("FROM class_invoices")
          && statement.includes("status IN ('issued', 'void')")) {
        return {
          rows: invoiceStatus === "draft" ? [] : [{
            id: INVOICE_ID,
            status: invoiceStatus,
            service_period_end: "2026-08-31",
            total_amount: "3300.0000",
          }],
        };
      }
      if (statement.includes("FROM class_budget_periods") && statement.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: BUDGET_ID,
            individual_id: INDIVIDUAL_ID,
            label: "2026 classes",
            start_date: "2026-01-01",
            end_date: "2026-12-31",
            authorized_amount: "20000.0000",
            status: budgetStatus,
            notes: "Legacy allowance",
            created_by_user_id: ACTOR_ID,
            updated_at: "2026-08-31T12:00:00.000Z",
            program_id: options.budgetProgramId ?? null,
            budget_period_id: budgetPeriodId,
            budget_authorization_id: budgetAuthorizationId,
          }],
        };
      }
      if (statement.includes("FROM class_budget_ledger")) {
        const rows: Array<Record<string, unknown>> = invoiceStatus === "draft" ? [] : [{
          class_invoice_id: INVOICE_ID,
          event_type: "issue",
          amount: options.ledgerMismatch ? "3200.0000" : "3300.0000",
          created_by_user_id: ACTOR_ID,
          created_at: "2026-08-31T12:00:00.000Z",
        }];
        if (invoiceStatus === "void") {
          rows.push({
            class_invoice_id: INVOICE_ID,
            event_type: "void",
            amount: "-3300.0000",
            created_by_user_id: ACTOR_ID,
            created_at: "2026-09-01T12:00:00.000Z",
          });
        }
        return { rows };
      }
      if (statement.includes("FROM programs") && statement.includes("FOR SHARE")) {
        return { rows: canonicalProgramId ? [{ id: canonicalProgramId }] : [] };
      }
      if (statement.includes("FROM budget_periods") && statement.includes("FOR UPDATE")) {
        return {
          rows: budgetPeriodId ? [{
            id: budgetPeriodId,
            individual_id: INDIVIDUAL_ID,
            start_date: "2026-01-01",
            end_date: "2026-12-31",
            status: budgetStatus,
            archived_at: budgetStatus === "closed" ? "2026-08-31T12:00:00.000Z" : null,
          }] : [],
        };
      }
      if (statement.includes("INSERT INTO budget_periods")) {
        return {
          rows: [{
            id: PERIOD_ID,
            individual_id: INDIVIDUAL_ID,
            start_date: "2026-01-01",
            end_date: "2026-12-31",
            status: budgetStatus,
            archived_at: budgetStatus === "closed" ? "2026-08-31T12:00:00.000Z" : null,
          }],
        };
      }
      if (statement.includes("FROM budget_authorizations") && statement.includes("FOR UPDATE")) {
        const shouldReturn = Boolean(budgetAuthorizationId) || options.existingAuthorization === true;
        return {
          rows: shouldReturn ? [{
            id: budgetAuthorizationId ?? AUTHORIZATION_ID,
            budget_period_id: budgetPeriodId ?? PERIOD_ID,
            individual_id: INDIVIDUAL_ID,
            program_id: PROGRAM_ID,
            authorized_dollars: "20000.0000",
            rate_basis: "dollars",
            status: "active",
            archived_at: null,
          }] : [],
        };
      }
      if (statement.includes("INSERT INTO budget_authorizations")) {
        return { rows: [{ id: AUTHORIZATION_ID }] };
      }
      if (statement.includes("FROM program_budget_events") && statement.includes("FOR UPDATE")) {
        return { rows: options.existingEvents ?? [] };
      }
      if (statement.includes("INSERT INTO program_budget_events") && statement.includes("'consume'")) {
        return {
          rows: [{
            id: CONSUME_ID,
            budget_period_id: budgetPeriodId ?? PERIOD_ID,
            individual_id: INDIVIDUAL_ID,
            program_id: PROGRAM_ID,
            event_type: "consume",
            service_date: "2026-08-31",
            hours: "0.0000",
            amount: "3300.0000",
            source_id: INVOICE_ID,
            reverses_event_id: null,
          }],
        };
      }
      if (statement.includes("INSERT INTO program_budget_events") && statement.includes("'reverse'")) {
        return {
          rows: [{
            id: REVERSE_ID,
            budget_period_id: budgetPeriodId ?? PERIOD_ID,
            individual_id: INDIVIDUAL_ID,
            program_id: PROGRAM_ID,
            event_type: "reverse",
            service_date: "2026-08-31",
            hours: "0.0000",
            amount: "-3300.0000",
            source_id: INVOICE_ID,
            reverses_event_id: CONSUME_ID,
          }],
        };
      }
      if (statement.includes("UPDATE budget_periods")) return { rows: [] };
      if (statement.includes("UPDATE class_budget_periods")) {
        return { rows: options.updateSucceeded === false ? [] : [{ id: BUDGET_ID }] };
      }
      if (statement.includes("INSERT INTO audit_logs")) return { rows: [] };
      throw new Error(`Unexpected query: ${statement}`);
    }),
    release: vi.fn(),
  } as unknown as PgLikeClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as PgLikePool;
  return { pool, calls };
}

function invoke(pool: PgLikePool, reason = "Confirmed legacy class budget repair") {
  return repairIssuedClassInvoiceProgramLink(pool, INVOICE_ID, {
    classBudgetPeriodId: BUDGET_ID,
    reason,
  }, ACTOR_ID);
}

describe("class allowance canonical bridge repair", () => {
  it("creates a missing program period and authorization, then backfills an issued invoice", async () => {
    const fixture = repairPool();

    const result = await invoke(fixture.pool);

    expect(result).toEqual({
      ok: true,
      data: { invoiceId: INVOICE_ID, classBudgetPeriodId: BUDGET_ID, programId: PROGRAM_ID },
    });
    expect(fixture.calls[0]?.statement).toBe("BEGIN");
    expect(fixture.calls[1]?.statement).toContain("pg_advisory_xact_lock");
    expect(fixture.calls[1]?.parameters).toEqual([SETTLEMENT_SOURCE_LOCK]);
    expect(fixture.calls[2]?.statement).toContain("FROM class_invoices");
    expect(fixture.calls[3]?.statement).toContain("ORDER BY id");
    expect(fixture.calls[4]?.statement).toContain("FROM class_budget_periods");

    const periodInsert = fixture.calls.find(({ statement }) => statement.includes("INSERT INTO budget_periods"));
    expect(periodInsert?.parameters).toEqual([
      INDIVIDUAL_ID, "2026 classes", "2026-01-01", "2026-12-31", "active",
      `class_bridge:${BUDGET_ID}`, "Legacy allowance", "2026-08-31T12:00:00.000Z",
    ]);
    const authInsert = fixture.calls.find(({ statement }) => statement.includes("INSERT INTO budget_authorizations"));
    expect(authInsert?.parameters).toEqual([
      PERIOD_ID, INDIVIDUAL_ID, PROGRAM_ID, "20000.0000", "Legacy allowance", ACTOR_ID,
    ]);
    const consume = fixture.calls.find(({ statement }) => (
      statement.includes("INSERT INTO program_budget_events") && statement.includes("'consume'")
    ));
    expect(consume?.parameters).toEqual([
      PERIOD_ID, INDIVIDUAL_ID, PROGRAM_ID, "2026-08-31", "3300.0000", INVOICE_ID,
      ACTOR_ID, "2026-08-31T12:00:00.000Z",
    ]);
    const update = fixture.calls.find(({ statement }) => statement.includes("UPDATE class_budget_periods"));
    expect(update?.statement).toContain("budget_authorization_id = $3");
    expect(update?.parameters).toEqual([
      PROGRAM_ID, PERIOD_ID, AUTHORIZATION_ID, ACTOR_ID, BUDGET_ID, null, null, null,
    ]);
    const audit = fixture.calls.find(({ statement }) => statement.includes("INSERT INTO audit_logs"));
    expect(audit?.parameters.slice(0, 5)).toEqual([
      ACTOR_ID, "class_invoice_program_link_repaired", "class_invoice", INVOICE_ID,
      "Confirmed legacy class budget repair",
    ]);
    expect(String(audit?.parameters[5])).toContain(`"budgetPeriodId":"${PERIOD_ID}"`);
    expect(String(audit?.parameters[5])).toContain(`"budgetAuthorizationId":"${AUTHORIZATION_ID}"`);
    expect(fixture.calls.at(-1)?.statement).toBe("COMMIT");
  });

  it("reuses a matching canonical period and active authorization for a partial migration", async () => {
    const fixture = repairPool({
      budgetPeriodId: PERIOD_ID,
      existingAuthorization: true,
    });

    await expect(invoke(fixture.pool)).resolves.toMatchObject({ ok: true });

    expect(fixture.calls.some(({ statement }) => statement.includes("INSERT INTO budget_periods"))).toBe(false);
    expect(fixture.calls.some(({ statement }) => statement.includes("INSERT INTO budget_authorizations"))).toBe(false);
    const update = fixture.calls.find(({ statement }) => statement.includes("UPDATE class_budget_periods"));
    expect(update?.parameters.slice(0, 5)).toEqual([
      PROGRAM_ID, PERIOD_ID, AUTHORIZATION_ID, ACTOR_ID, BUDGET_ID,
    ]);
  });

  it("is safe to retry after every canonical link and issue event already exist", async () => {
    const fixture = repairPool({
      budgetProgramId: PROGRAM_ID,
      budgetPeriodId: PERIOD_ID,
      budgetAuthorizationId: AUTHORIZATION_ID,
      existingEvents: [{
        id: CONSUME_ID,
        budget_period_id: PERIOD_ID,
        individual_id: INDIVIDUAL_ID,
        program_id: PROGRAM_ID,
        event_type: "consume",
        service_date: "2026-08-31",
        hours: "0.0000",
        amount: "3300.0000",
        source_id: INVOICE_ID,
        reverses_event_id: null,
      }],
    });

    await expect(invoke(fixture.pool)).resolves.toMatchObject({ ok: true });

    expect(fixture.calls.some(({ statement }) => statement.includes("INSERT INTO budget_periods"))).toBe(false);
    expect(fixture.calls.some(({ statement }) => statement.includes("INSERT INTO budget_authorizations"))).toBe(false);
    expect(fixture.calls.some(({ statement }) => statement.includes("INSERT INTO program_budget_events"))).toBe(false);
    expect(fixture.calls.at(-1)?.statement).toBe("COMMIT");
  });

  it("backfills consume and reversal events and restores a closed period", async () => {
    const fixture = repairPool({ invoiceStatus: "void", budgetStatus: "closed" });

    await expect(invoke(fixture.pool)).resolves.toMatchObject({ ok: true });

    const periodUpdates = fixture.calls.filter(({ statement }) => statement.includes("UPDATE budget_periods"));
    expect(periodUpdates).toHaveLength(2);
    expect(periodUpdates[0]?.statement).toContain("status = 'active'");
    expect(periodUpdates[1]?.statement).toContain("status = 'closed'");
    const consumeIndex = fixture.calls.findIndex(({ statement }) => (
      statement.includes("INSERT INTO program_budget_events") && statement.includes("'consume'")
    ));
    const reverseIndex = fixture.calls.findIndex(({ statement }) => (
      statement.includes("INSERT INTO program_budget_events") && statement.includes("'reverse'")
    ));
    expect(consumeIndex).toBeGreaterThan(-1);
    expect(reverseIndex).toBeGreaterThan(consumeIndex);
    expect(fixture.calls[reverseIndex]?.parameters[6]).toBe(CONSUME_ID);
  });

  it("rejects a stale expected budget before touching another allowance", async () => {
    const fixture = repairPool({ invoiceBudgetId: OTHER_BUDGET_ID });

    const result = await invoke(fixture.pool);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(fixture.calls.some(({ statement }) => statement.includes("FROM class_budget_periods"))).toBe(false);
    expect(fixture.calls.at(-1)?.statement).toBe("ROLLBACK");
  });

  it("rejects invoices that are still drafts", async () => {
    const fixture = repairPool({ invoiceStatus: "draft" });

    const result = await invoke(fixture.pool);

    expect(result).toMatchObject({ ok: false, code: "immutable" });
    expect(fixture.calls.some(({ statement }) => statement.includes("FROM class_budget_periods"))).toBe(false);
  });

  it("rejects a budget linked to a different program", async () => {
    const fixture = repairPool({ budgetProgramId: OTHER_PROGRAM_ID });

    const result = await invoke(fixture.pool);

    expect(result).toMatchObject({
      ok: false,
      code: "conflict",
      message: expect.stringContaining("different program"),
    });
    expect(fixture.calls.some(({ statement }) => statement.includes("INSERT INTO program_budget_events"))).toBe(false);
  });

  it("does not change the allowance when the active Classes program is unavailable", async () => {
    const fixture = repairPool({ canonicalProgramId: null });

    const result = await invoke(fixture.pool);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(fixture.calls.some(({ statement }) => statement.includes("INSERT INTO budget_periods"))).toBe(false);
  });

  it("rolls back when the class ledger does not match the issued invoice", async () => {
    const fixture = repairPool({ ledgerMismatch: true });

    const result = await invoke(fixture.pool);

    expect(result).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("ledger") });
    expect(fixture.calls.some(({ statement }) => statement.includes("INSERT INTO program_budget_events"))).toBe(false);
    expect(fixture.calls.at(-1)?.statement).toBe("ROLLBACK");
  });

  it("rejects a canonical event that belongs to another budget", async () => {
    const fixture = repairPool({
      existingEvents: [{
        id: CONSUME_ID,
        budget_period_id: OTHER_BUDGET_ID,
        individual_id: INDIVIDUAL_ID,
        program_id: PROGRAM_ID,
        event_type: "consume",
        service_date: "2026-08-31",
        hours: "0.0000",
        amount: "3300.0000",
        source_id: INVOICE_ID,
        reverses_event_id: null,
      }],
    });

    const result = await invoke(fixture.pool);

    expect(result).toMatchObject({
      ok: false,
      code: "conflict",
      message: expect.stringContaining("different program-budget event"),
    });
    expect(fixture.calls.at(-1)?.statement).toBe("ROLLBACK");
  });

  it("rejects a guarded update that observes changed legacy links", async () => {
    const fixture = repairPool({ updateSucceeded: false });

    const result = await invoke(fixture.pool);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(fixture.calls.some(({ statement }) => statement.includes("INSERT INTO audit_logs"))).toBe(false);
    expect(fixture.calls.at(-1)?.statement).toBe("ROLLBACK");
  });
});
