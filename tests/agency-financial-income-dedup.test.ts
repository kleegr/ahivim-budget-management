import { describe, expect, it } from "vitest";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { createManualIncomeEntry } from "@/lib/manage/agency-financials";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const INDIVIDUAL_ID = "55555555-5555-4555-8555-555555555555";
const PROGRAM_ID = "66666666-6666-4666-8666-666666666666";

type AutomaticMatch = {
  source_type: "google_sheet_transaction";
  source_id: string;
  source_ref: string;
};

function incomePool(
  matches: AutomaticMatch[],
  referencedClassInvoice: {
    id: string;
    individual_id: string;
    program_id: string | null;
    invoice_date: string;
    status: "draft" | "issued" | "void";
    custom_split_required: boolean;
  } | null = null,
  hasEffectiveTerm = true,
) {
  const statements: string[] = [];
  const automaticQueryParameters: unknown[][] = [];
  const auditParameters: unknown[][] = [];
  const effectiveTermParameters: unknown[][] = [];
  const insertParameters: unknown[][] = [];
  let created = 0;

  const client = {
    query: async (statement: string, parameters: unknown[] = []) => {
      statements.push(statement);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [] };
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (statement.includes("FROM agency_manual_income_entries")
          && statement.includes("lower(btrim(source_ref))")) return { rows: [] };
      if (statement.includes("FROM class_invoices invoice")
          && statement.includes("lower(btrim(invoice.invoice_number))")) {
        return { rows: referencedClassInvoice ? [referencedClassInvoice] : [] };
      }
      if (statement.includes("FROM agency_manual_income_entries")
          && statement.includes("NULLIF(btrim(source_ref), '') IS NULL")) {
        return { rows: created > 0 ? [{ id: `22222222-2222-4222-8222-22222222222${created}` }] : [] };
      }
      if (statement.includes("WITH automatic_income AS")) {
        automaticQueryParameters.push(parameters);
        return { rows: matches };
      }
      if (statement.includes("AS individual_exists")) {
        return { rows: [{ individual_exists: true, program_exists: true }] };
      }
      if (statement.includes("FROM individual_program_revenue_terms")) {
        effectiveTermParameters.push(parameters);
        return { rows: hasEffectiveTerm
          ? [{ id: "77777777-7777-4777-8777-777777777777", agency_share_percent: "0.600000" }]
          : [] };
      }
      if (statement.includes("FROM program_budget_balances")) {
        return { rows: [{
          authorization_id: "88888888-8888-4888-8888-888888888888",
          budget_period_id: "99999999-9999-4999-8999-999999999999",
          required_auth_type: "dollars",
          consumption_source: "manual",
          authorized_dollars: "1000",
          consumed_dollars: "100",
        }] };
      }
      if (statement.includes("FROM budget_authorizations") && statement.includes("FOR UPDATE")) {
        return { rows: [{ id: "88888888-8888-4888-8888-888888888888" }] };
      }
      if (statement.includes("INSERT INTO agency_manual_income_entries")) {
        insertParameters.push(parameters);
        created += 1;
        return { rows: [{ id: `22222222-2222-4222-8222-22222222222${created}` }] };
      }
      if (statement.includes("INSERT INTO audit_logs")) {
        auditParameters.push(parameters);
        return { rows: [] };
      }
      if (statement.includes("WHERE entry.id = $1")) {
        return { rows: [{
          id: parameters[0],
          service_date: "2026-08-15",
          source_type: "reimbursement",
          individual_id: null,
          individual_name: null,
          program_id: null,
          program_code: null,
          program_name: null,
          gross_amount: "50",
          agency_share_percent: "1",
          agency_amount: "50",
          individual_amount: "0",
          source_ref: null,
          notes: null,
          status: "active",
          void_reason: null,
          program_budget_event_id: null,
          created_at: "2026-08-15T12:00:00Z",
        }] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
    release: () => undefined,
  } as unknown as PgLikeClient;

  const pool = {
    connect: async () => client,
  } as unknown as PgLikePool;

  return {
    pool,
    statements,
    automaticQueryParameters,
    auditParameters,
    effectiveTermParameters,
    insertParameters,
  };
}

const baseInput = {
  serviceDate: "2026-08-15",
  sourceType: "reimbursement" as const,
  grossAmount: "50",
};

describe("manual agency income automatic-source duplicate protection", () => {
  it("blocks an exact Google Sheet match even when the reference is blank", async () => {
    const fixture = incomePool([{
      source_type: "google_sheet_transaction",
      source_id: "33333333-3333-4333-8333-333333333333",
      source_ref: "CHECK-100",
    }]);

    const result = await createManualIncomeEntry(
      fixture.pool,
      { ...baseInput, individualId: INDIVIDUAL_ID, programId: PROGRAM_ID },
      ACTOR_ID,
    );

    expect(result).toEqual({
      ok: false,
      code: "conflict",
      message: expect.stringContaining("Google Sheet transaction CHECK-100"),
    });
    const sourceQuery = fixture.statements.find((statement) => statement.includes("WITH automatic_income AS"));
    expect(sourceQuery).toContain("canonical_service_date");
    expect(sourceQuery).not.toContain("class_invoices");
    expect(sourceQuery).toContain("($3::uuid IS NULL OR individual_id = $3::uuid)");
    expect(sourceQuery).toContain("($4::uuid IS NULL OR program_id = $4::uuid)");
    expect(fixture.automaticQueryParameters).toEqual([[
      "2026-08-15",
      "50.0000",
      INDIVIDUAL_ID,
      PROGRAM_ID,
    ]]);
  });

  it("treats omitted individual and program dimensions as wildcards", async () => {
    const fixture = incomePool([{
      source_type: "google_sheet_transaction",
      source_id: "33333333-3333-4333-8333-333333333333",
      source_ref: "CHECK-100",
    }]);

    const result = await createManualIncomeEntry(fixture.pool, baseInput, ACTOR_ID);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(fixture.automaticQueryParameters).toEqual([[
      "2026-08-15",
      "50.0000",
      null,
      null,
    ]]);
  });

  it("rejects a dimensionless class receipt before it can match an unrelated Sheet row", async () => {
    const fixture = incomePool([{
      source_type: "google_sheet_transaction",
      source_id: "33333333-3333-4333-8333-333333333333",
      source_ref: "COINCIDENTAL-CHECK",
    }]);

    const result = await createManualIncomeEntry(
      fixture.pool,
      { ...baseInput, sourceType: "class" },
      ACTOR_ID,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "validation",
      message: expect.stringContaining("Choose an individual and program"),
    });
    expect(fixture.automaticQueryParameters).toHaveLength(0);
    expect(fixture.statements).toHaveLength(0);
  });

  it("accepts a class receipt that enriches an existing Sheet payment without consuming class budget", async () => {
    const sheetId = "33333333-3333-4333-8333-333333333333";
    const fixture = incomePool([{
      source_type: "google_sheet_transaction",
      source_id: sheetId,
      source_ref: "CHECK-CLASS-100",
    }]);

    const result = await createManualIncomeEntry(
      fixture.pool,
      {
        ...baseInput,
        sourceType: "class",
        individualId: INDIVIDUAL_ID,
        programId: PROGRAM_ID,
      },
      ACTOR_ID,
    );

    expect(result.ok).toBe(true);
    expect(fixture.statements.some((statement) => statement.includes("INSERT INTO program_budget_events")))
      .toBe(false);
    expect(String(fixture.auditParameters[0]?.[5])).toContain(`"sourceId":"${sheetId}"`);
    expect(String(fixture.auditParameters[0]?.[5])).toContain('"reason":null');
  });

  it("records an actual class receipt by invoice reference without consuming the allowance twice", async () => {
    const invoiceId = "44444444-4444-4444-8444-444444444444";
    const fixture = incomePool([], {
      id: invoiceId,
      individual_id: INDIVIDUAL_ID,
      program_id: PROGRAM_ID,
      invoice_date: "2026-07-10",
      status: "issued",
      custom_split_required: true,
    });

    const result = await createManualIncomeEntry(
      fixture.pool,
      {
        ...baseInput,
        sourceType: "class",
        sourceRef: "CLASS-08",
      },
      ACTOR_ID,
    );

    expect(result.ok).toBe(true);
    expect(fixture.statements.some((statement) => statement.includes("INSERT INTO program_budget_events")))
      .toBe(false);
    expect(fixture.statements.find((statement) => statement.includes("WITH automatic_income AS")))
      .not.toContain("class_invoices");
    expect(fixture.statements.find((statement) => statement.includes("FROM class_invoices invoice")))
      .toContain("FOR SHARE OF invoice, budget");
    expect(fixture.automaticQueryParameters).toEqual([[
      "2026-08-15",
      "50.0000",
      INDIVIDUAL_ID,
      PROGRAM_ID,
    ]]);
    expect(fixture.effectiveTermParameters).toEqual([[
      INDIVIDUAL_ID,
      PROGRAM_ID,
      "2026-07-10",
    ]]);
    expect(fixture.insertParameters[0]?.slice(2, 4)).toEqual([INDIVIDUAL_ID, PROGRAM_ID]);
    expect(String(fixture.auditParameters[0]?.[5])).toContain(`"referencedClassInvoiceId":"${invoiceId}"`);
    expect(String(fixture.auditParameters[0]?.[5])).toContain('"budgetEventId":null');
  });

  it("rejects invoice-reference selections that belong to another person or program", async () => {
    const fixture = incomePool([], {
      id: "44444444-4444-4444-8444-444444444444",
      individual_id: INDIVIDUAL_ID,
      program_id: PROGRAM_ID,
      invoice_date: "2026-07-10",
      status: "issued",
      custom_split_required: false,
    });

    const result = await createManualIncomeEntry(
      fixture.pool,
      {
        ...baseInput,
        sourceType: "class",
        individualId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        programId: PROGRAM_ID,
        sourceRef: "CLASS-08",
      },
      ACTOR_ID,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "conflict",
      message: expect.stringContaining("different individual or program"),
    });
    expect(fixture.insertParameters).toHaveLength(0);
  });

  it.each(["draft", "void"] as const)("rejects a %s invoice as a payment reference", async (status) => {
    const fixture = incomePool([], {
      id: "44444444-4444-4444-8444-444444444444",
      individual_id: INDIVIDUAL_ID,
      program_id: PROGRAM_ID,
      invoice_date: "2026-07-10",
      status,
      custom_split_required: false,
    });

    const result = await createManualIncomeEntry(
      fixture.pool,
      { ...baseInput, sourceType: "class", sourceRef: "CLASS-08" },
      ACTOR_ID,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "conflict",
      message: expect.stringContaining("not issued"),
    });
    expect(fixture.insertParameters).toHaveLength(0);
  });

  it("rejects a legacy issued invoice until its Classes program link is repaired", async () => {
    const fixture = incomePool([], {
      id: "44444444-4444-4444-8444-444444444444",
      individual_id: INDIVIDUAL_ID,
      program_id: null,
      invoice_date: "2026-07-10",
      status: "issued",
      custom_split_required: false,
    });

    const result = await createManualIncomeEntry(
      fixture.pool,
      { ...baseInput, sourceType: "class", sourceRef: "CLASS-08" },
      ACTOR_ID,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "conflict",
      message: expect.stringContaining("Repair this invoice's Classes program link"),
    });
    expect(fixture.insertParameters).toHaveLength(0);
  });

  it("rejects an invoice receipt when required split history has no effective rule", async () => {
    const fixture = incomePool([], {
      id: "44444444-4444-4444-8444-444444444444",
      individual_id: INDIVIDUAL_ID,
      program_id: PROGRAM_ID,
      invoice_date: "2026-07-10",
      status: "issued",
      custom_split_required: true,
    }, false);

    const result = await createManualIncomeEntry(
      fixture.pool,
      { ...baseInput, sourceType: "class", sourceRef: "CLASS-08" },
      ACTOR_ID,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "conflict",
      message: expect.stringContaining("effective program split for this invoice date"),
    });
    expect(fixture.insertParameters).toHaveLength(0);
  });

  it("allows a legitimate same-value payment with a reason and audits the matched source", async () => {
    const fixture = incomePool([{
      source_type: "google_sheet_transaction",
      source_id: "33333333-3333-4333-8333-333333333333",
      source_ref: "CHECK-100",
    }]);

    const result = await createManualIncomeEntry(
      fixture.pool,
      {
        ...baseInput,
        automaticSourceOverrideReason: "Separate reimbursement received on the same day",
        notes: "Owner-entered note",
      },
      ACTOR_ID,
    );

    expect(result.ok).toBe(true);
    expect(fixture.auditParameters).toHaveLength(1);
    expect(fixture.auditParameters[0]?.[4]).toBe("Separate reimbursement received on the same day");
    expect(String(fixture.auditParameters[0]?.[5])).toContain('"sourceId":"33333333-3333-4333-8333-333333333333"');
    expect(String(fixture.auditParameters[0]?.[5])).toContain('"automaticSourceOverride"');
  });

  it("blocks an exact blank-reference retry after the first manual income is saved", async () => {
    const fixture = incomePool([]);

    const first = await createManualIncomeEntry(fixture.pool, baseInput, ACTOR_ID);
    const second = await createManualIncomeEntry(fixture.pool, baseInput, ACTOR_ID);

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      code: "conflict",
      message: expect.stringContaining("exact income is already recorded"),
    });
    expect(fixture.statements.filter((statement) => (
      statement.includes("INSERT INTO agency_manual_income_entries")
    ))).toHaveLength(1);
  });

  it("allows an intentional duplicate manual payment with a reason and audits the override", async () => {
    const fixture = incomePool([]);

    const first = await createManualIncomeEntry(fixture.pool, baseInput, ACTOR_ID);
    const second = await createManualIncomeEntry(fixture.pool, {
      ...baseInput,
      automaticSourceOverrideReason: "This is a second reimbursement received separately",
    }, ACTOR_ID);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fixture.auditParameters).toHaveLength(2);
    expect(fixture.auditParameters[1]?.[4]).toBe("This is a second reimbursement received separately");
    expect(String(fixture.auditParameters[1]?.[5])).toContain('"manualIncomeOverride"');
    expect(String(fixture.auditParameters[1]?.[5])).toContain('"sourceId":"22222222-2222-4222-8222-222222222221"');
  });
});
