import { describe, expect, it } from "vitest";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import {
  countManualIncomeSeparately,
  listManualIncomeEntries,
} from "@/lib/manage/agency-financials";
import { SETTLEMENT_SOURCE_LOCK } from "@/lib/manage/settlement-freshness";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ENTRY_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "44444444-4444-4444-8444-444444444444";

function decisionPool(sourceExists = true) {
  const calls: Array<{ statement: string; parameters: unknown[] }> = [];
  const auditParameters: unknown[][] = [];
  const sourceParameters: unknown[][] = [];
  const client = {
    query: async (statement: string, parameters: unknown[] = []) => {
      calls.push({ statement, parameters });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [] };
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("WITH automatic_income AS")) {
        sourceParameters.push(parameters);
        return { rows: sourceExists ? [{
          source_type: parameters[0],
          source_id: parameters[1],
          source_ref: "CHECK-44",
        }] : [] };
      }
      if (statement.includes("FROM agency_manual_income_entries") && statement.includes("FOR UPDATE")) {
        return { rows: [{
          service_date: "2026-08-15",
          gross_amount: "50",
          individual_id: null,
          program_id: null,
          status: "active",
        }] };
      }
      if (statement.includes("INSERT INTO audit_logs")) {
        auditParameters.push(parameters);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
    release: () => undefined,
  } as unknown as PgLikeClient;
  return {
    pool: { connect: async () => client } as unknown as PgLikePool,
    calls,
    auditParameters,
    sourceParameters,
  };
}

describe("owner separate-income decisions", () => {
  it("does not treat an issued invoice as an actual-income source", async () => {
    const fixture = decisionPool();
    const result = await countManualIncomeSeparately(fixture.pool, ENTRY_ID, {
      sourceType: "issued_class_invoice",
      sourceId: SOURCE_ID,
      reason: "This should never be needed for a receivable",
    }, ACTOR_ID);

    expect(result).toMatchObject({ ok: false, code: "validation" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("audits a manual-income decision against the exact live source", async () => {
    const fixture = decisionPool();
    const result = await countManualIncomeSeparately(fixture.pool, ENTRY_ID, {
      sourceType: "google_sheet_transaction",
      sourceId: SOURCE_ID,
      reason: "This was a second payment for another service",
    }, ACTOR_ID);

    expect(result).toEqual({ ok: true, data: { id: ENTRY_ID } });
    expect(fixture.calls[0]?.statement).toBe("BEGIN");
    expect(fixture.calls[1]).toMatchObject({
      parameters: [SETTLEMENT_SOURCE_LOCK],
    });
    expect(fixture.calls[1]?.statement).toContain("pg_advisory_xact_lock");
    expect(fixture.sourceParameters).toEqual([[
      "google_sheet_transaction", SOURCE_ID, "2026-08-15", "50", null, null,
    ]]);
    expect(fixture.auditParameters[0]?.slice(0, 5)).toEqual([
      ACTOR_ID,
      "agency_income.counted_separately",
      "agency_manual_income_entry",
      ENTRY_ID,
      "This was a second payment for another service",
    ]);
    expect(String(fixture.auditParameters[0]?.[5])).toContain(`"sourceId":"${SOURCE_ID}"`);
    expect(String(fixture.auditParameters[0]?.[5])).toContain('"sourceRef":"CHECK-44"');
  });

  it("reverses a manual-income override with an audited same-payment decision", async () => {
    const fixture = decisionPool();
    const result = await countManualIncomeSeparately(fixture.pool, ENTRY_ID, {
      action: "treat_as_same_payment",
      sourceType: "google_sheet_transaction",
      sourceId: SOURCE_ID,
      reason: "The owner confirmed both records describe one receipt",
    }, ACTOR_ID);

    expect(result).toEqual({ ok: true, data: { id: ENTRY_ID } });
    expect(fixture.sourceParameters).toEqual([[
      "google_sheet_transaction", SOURCE_ID, "2026-08-15", "50", null, null,
    ]]);
    expect(fixture.auditParameters[0]?.slice(0, 5)).toEqual([
      ACTOR_ID,
      "agency_income.treated_as_same_payment",
      "agency_manual_income_entry",
      ENTRY_ID,
      "The owner confirmed both records describe one receipt",
    ]);
    expect(String(fixture.auditParameters[0]?.[5])).toContain('"incomeMatchingDecision":"same_payment"');
    expect(String(fixture.auditParameters[0]?.[5])).toContain('"automaticSourceOverride":null');
    expect(String(fixture.auditParameters[0]?.[5])).toContain(`"sourceId":"${SOURCE_ID}"`);
  });

  it("reads the latest positive or reversal audit as the current manual-income decision", async () => {
    let statement = "";
    await listManualIncomeEntries({
      query: async (sql: string) => {
        statement = sql;
        return { rows: [] };
      },
    } as unknown as PgLikePool);

    expect(statement).toContain("agency_income.treated_as_same_payment");
    expect(statement).toContain("CASE WHEN audit.action IN");
    expect(statement).toContain("ELSE NULL");
    expect(statement).toContain("ORDER BY audit.created_at DESC, audit.id DESC");
  });

  it("rejects a stale decision when the selected source no longer matches", async () => {
    const fixture = decisionPool(false);
    const result = await countManualIncomeSeparately(fixture.pool, ENTRY_ID, {
      sourceType: "google_sheet_transaction",
      sourceId: SOURCE_ID,
      reason: "A separate receipt was confirmed by the owner",
    }, ACTOR_ID);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(fixture.auditParameters).toHaveLength(0);
  });
});
