import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  listCurrentProgramBudgets,
  listProgramBudgetMonthlyHistory,
  listProgramBudgets,
} from "@/lib/data/program-budgets";
import type { PgLikePool } from "@/lib/import/commit";
import { createIndividual } from "@/lib/manage/individuals";
import {
  createAuthorization,
  createBudgetPeriod,
  cancelAuthorization,
  reviseAuthorization,
  updateBudgetPeriodRenewal,
} from "@/lib/manage/authorizations";
import { createClassBudget, updateClassBudget } from "@/lib/manage/class-invoices";
import { getProgramRules, updateProgramRules } from "@/lib/manage/program-rules";
import {
  createProgramBudget,
  createProgramBudgetEvent,
  reverseProgramBudgetEvent,
} from "@/lib/manage/program-budgets";
import {
  closeTestPool,
  hasTestDatabase,
  resetSchema,
  testPool,
  truncateBusinessTables,
} from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

async function programId(code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM programs WHERE code = $1`, [code]);
  if (!rows[0]) throw new Error(`Program ${code} was not seeded.`);
  return rows[0].id;
}

suite("canonical program budgets (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);

  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES ($1, 'program-budgets@ahivim.test', 'Program Budget Admin', 'x', 'admin')`,
      [ACTOR],
    );
  });

  afterAll(closeTestPool);

  it("backfills known routing metadata and seeds Classes as a dollar invoice program", async () => {
    const { rows } = await pool.query<{
      code: string;
      service_category: string;
      payment_recipient: string;
      consumption_source: string;
      rate_scope: string;
      required_auth_type: string;
    }>(
      `SELECT code, service_category, payment_recipient, consumption_source,
              rate_scope, required_auth_type
         FROM programs
        WHERE code IN ('SH_COM_HAB', 'DAY_HAB', 'CLASSES')
        ORDER BY code`,
    );
    const byCode = Object.fromEntries(rows.map((row) => [row.code, row]));
    expect(byCode.SH_COM_HAB).toMatchObject({
      service_category: "self_hire",
      payment_recipient: "employee",
      consumption_source: "payroll",
      rate_scope: "per_individual",
    });
    expect(byCode.DAY_HAB).toMatchObject({
      service_category: "group_service",
      rate_scope: "per_group",
    });
    expect(byCode.CLASSES).toMatchObject({
      service_category: "classes",
      consumption_source: "invoice",
      required_auth_type: "dollars",
    });

    const custom = await pool.query<{ id: string }>(
      `INSERT INTO programs (code, name) VALUES ('CATALOG_TEST', 'Catalog Test')
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    );
    unwrap(await updateProgramRules(pool, custom.rows[0]!.id, {
      serviceCategory: "education",
      paymentRecipient: "external",
      consumptionSource: "mixed",
      rateScope: "flat",
      renewalPolicy: "rolling",
      requiredAuthType: "both",
    }, ACTOR, "Test the configurable catalog"));
    expect(await getProgramRules(pool, custom.rows[0]!.id)).toMatchObject({
      serviceCategory: "education",
      paymentRecipient: "external",
      consumptionSource: "mixed",
      rateScope: "flat",
      renewalPolicy: "rolling",
      requiredAuthType: "both",
    });
  });

  it("posts, deduplicates and reverses dollar consumption while deriving the balance", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Program Budget Person" }, ACTOR));
    const genericProgram = await pool.query<{ id: string }>(
      `INSERT INTO programs
         (code, name, required_auth_type, service_category, payment_recipient,
          consumption_source, rate_scope, renewal_policy, allow_individual_rate_override)
       VALUES ('GENERIC_DOLLAR_TEST', 'Generic dollar allowance', 'dollars', 'other',
               'agency', 'manual', 'flat', 'individual', false)
       RETURNING id`,
    );
    const genericProgramId = genericProgram.rows[0]!.id;
    const budget = unwrap(await createProgramBudget(pool, {
      individualId: person.id,
      programId: genericProgramId,
      label: "Generic allowance 2026",
      renewalDate: "2027-01-01",
      authorizedDollars: "1000",
    }, ACTOR));
    expect(budget).toMatchObject({
      authorizedHours: "0.0000",
      authorizedDollars: "1000.0000",
      remainingDollars: "1000.0000",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    unwrap(await updateBudgetPeriodRenewal(
      pool,
      budget.budgetPeriodId,
      "2027-02-01",
      ACTOR,
      "Renewal date corrected",
    ));
    expect((await listProgramBudgets(pool, { individualId: person.id }))[0]).toMatchObject({
      startDate: "2026-02-01",
      endDate: "2027-01-31",
      renewalDate: "2027-02-01",
      requiredAuthType: "dollars",
    });

    const input = {
      budgetPeriodId: budget.budgetPeriodId,
      programId: genericProgramId,
      eventType: "consume" as const,
      serviceDate: "2026-08-15",
      amount: "150",
      sourceType: "test_invoice",
      sourceId: "INV-001",
    };
    const first = unwrap(await createProgramBudgetEvent(pool, input, ACTOR));
    const retry = unwrap(await createProgramBudgetEvent(pool, input, ACTOR));
    expect(retry.id).toBe(first.id);

    let current = (await listProgramBudgets(pool, { individualId: person.id }))[0];
    expect(current).toMatchObject({ consumedDollars: "150.0000", remainingDollars: "850.0000" });

    const reversal = unwrap(await reverseProgramBudgetEvent(pool, first.id, ACTOR, "Invoice was voided"));
    const reversalRetry = unwrap(await reverseProgramBudgetEvent(pool, first.id, ACTOR, "Invoice was voided"));
    expect(reversalRetry.id).toBe(reversal.id);
    current = (await listProgramBudgets(pool, { individualId: person.id }))[0];
    expect(current).toMatchObject({ consumedDollars: "0.0000", remainingDollars: "1000.0000" });

    const negativeAdjustment = unwrap(await createProgramBudgetEvent(pool, {
      budgetPeriodId: budget.budgetPeriodId,
      programId: genericProgramId,
      eventType: "adjust",
      serviceDate: "2026-08-16",
      amount: "-75",
      sourceType: "manual",
      sourceId: "NEGATIVE-ADJUSTMENT-001",
      note: "Correct duplicated usage",
    }, ACTOR));
    const positiveReversal = unwrap(await reverseProgramBudgetEvent(
      pool,
      negativeAdjustment.id,
      ACTOR,
      "Correction was not needed",
    ));
    expect(positiveReversal.amount).toBe("75.0000");
    current = (await listProgramBudgets(pool, { individualId: person.id }))[0];
    expect(current).toMatchObject({ consumedDollars: "0.0000", remainingDollars: "1000.0000" });

    await expect(pool.query(`UPDATE program_budget_events SET amount = 1 WHERE id = $1`, [first.id]))
      .rejects.toThrow(/append-only/i);
  });

  it("enforces the catalog authorization type", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Hours Budget Person" }, ACTOR));
    const comHabId = await programId("COM_HAB");
    const missingHours = await createProgramBudget(pool, {
      individualId: person.id,
      programId: comHabId,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      periodType: "custom",
      authorizedDollars: "5000",
    }, ACTOR);
    expect(missingHours).toMatchObject({ ok: false, code: "validation" });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM budget_periods WHERE individual_id = $1`,
      [person.id],
    )).rows[0]?.count).toBe("0");
  });

  it("uses the canonical payroll service date and flags undated usage without consuming it", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Canonical Service Date Person" }, ACTOR));
    const comHabId = await programId("COM_HAB");
    unwrap(await createProgramBudget(pool, {
      individualId: person.id,
      programId: comHabId,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      periodType: "custom",
      authorizedHours: "100",
    }, ACTOR));

    await pool.query(
      `INSERT INTO payroll_transactions
         (individual_id, program_id, period_begin, check_date, period_end,
          imported_hours, imported_amount, transaction_fingerprint)
       VALUES
         ($1, $2, '2026-02-01', NULL, '2026-02-28', 1, 10, 'canonical-period-begin'),
         ($1, $2, NULL, '2026-03-15', '2026-03-31', 2, 20, 'canonical-check-date'),
         ($1, $2, NULL, NULL, '2026-04-30', 3, 30, 'canonical-period-end'),
         ($1, $2, NULL, NULL, NULL, 4, 40, 'canonical-undated'),
         ($1, $2, '2025-12-31', '2026-05-15', '2026-05-31', 5, 50, 'canonical-priority')`,
      [person.id, comHabId],
    );

    const sessions = await pool.query<{ id: string; duration_hours: string }>(
      `INSERT INTO scheduled_sessions
         (program_id, session_date, duration_hours, status)
       VALUES
         ($1, '2026-05-10', 12, 'pending'),
         ($1, '2026-06-10', 9, 'completed'),
         ($1, '2027-01-10', 8, 'pending')
       RETURNING id, duration_hours::text AS duration_hours`,
      [comHabId],
    );
    for (const session of sessions.rows) {
      await pool.query(
        `INSERT INTO scheduled_allocations
           (scheduled_session_id, individual_id, allocation_hours)
         VALUES ($1, $2, $3)`,
        [session.id, person.id, session.duration_hours],
      );
    }

    const current = (await listProgramBudgets(pool, { individualId: person.id }))[0]!;
    expect(current).toMatchObject({
      consumedHours: "6.0000",
      consumedDollars: "60.0000",
      remainingHours: "94.0000",
      scheduledHours: "12.0000",
      remainingAfterScheduledHours: "82.0000",
      undatedUsageCount: 1,
      hasUndatedUsage: true,
    });
    const history = await listProgramBudgetMonthlyHistory(
      pool,
      current.budgetPeriodId,
      current.programId,
      new Date("2026-05-15T12:00:00.000Z"),
    );
    expect(history.find((month) => month.month === "2026-02")).toMatchObject({ usedHours: "1.0000" });
    expect(history.find((month) => month.month === "2026-03")).toMatchObject({ usedHours: "2.0000" });
    expect(history.find((month) => month.month === "2026-04")).toMatchObject({ usedHours: "3.0000" });
    expect(history.find((month) => month.month === "2026-05")).toMatchObject({ scheduledHours: "12.0000" });
  });

  it("uses catalog rate defaults, preserves rate revisions, and enforces the override rule", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Rate Override Person" }, ACTOR));
    const comHabId = await programId("COM_HAB");
    const budget = unwrap(await createProgramBudget(pool, {
      individualId: person.id,
      programId: comHabId,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      periodType: "custom",
      authorizedHours: "100",
    }, ACTOR));
    expect(budget).toMatchObject({
      agencyRate: "25.0000",
      internalRate: "21.0000",
      individualRateOverride: null,
    });

    const revised = unwrap(await reviseAuthorization(pool, budget.authorizationId, {
      authorizedHours: "120",
      agencyRate: "26",
      individualRateOverride: "22",
      notes: "Individual approved rate",
    }, ACTOR, "Updated individual agreement"));
    expect(revised).toMatchObject({
      revision: 2,
      agencyRate: "26.0000",
      internalRate: "22.0000",
      individualRateOverride: "22.0000",
    });
    expect((await listProgramBudgets(pool, { individualId: person.id }))[0]).toMatchObject({
      authorizationId: revised.id,
      agencyRate: "26.0000",
      internalRate: "22.0000",
      individualRateOverride: "22.0000",
    });

    await updateProgramRules(pool, comHabId, { allowIndividualRateOverride: false }, ACTOR);
    try {
      const rejected = await reviseAuthorization(pool, revised.id, { agencyRate: "27" }, ACTOR, "Disallowed rate");
      expect(rejected).toMatchObject({ ok: false, code: "validation" });
    } finally {
      await updateProgramRules(pool, comHabId, { allowIndividualRateOverride: true }, ACTOR);
    }
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM budget_authorizations
        WHERE budget_period_id = $1 AND program_id = $2 AND status = 'active'`,
      [budget.budgetPeriodId, comHabId],
    )).rows[0]?.count).toBe("1");
  });

  it("serializes concurrent overlapping authorization creates", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Concurrent Authorization Person" }, ACTOR));
    const comHabId = await programId("COM_HAB");
    const firstPeriod = unwrap(await createBudgetPeriod(pool, {
      individualId: person.id,
      label: "First",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    }, ACTOR));
    const secondPeriod = unwrap(await createBudgetPeriod(pool, {
      individualId: person.id,
      label: "Overlapping",
      startDate: "2026-06-01",
      endDate: "2027-05-31",
    }, ACTOR));

    const results = await Promise.all([
      createAuthorization(pool, {
        budgetPeriodId: firstPeriod.id,
        programId: comHabId,
        authorizedHours: "100",
      }, ACTOR),
      createAuthorization(pool, {
        budgetPeriodId: secondPeriod.id,
        programId: comHabId,
        authorizedHours: "100",
      }, ACTOR),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "conflict")).toHaveLength(1);
  });

  it("serializes concurrent Make editable submissions without leaving an orphan period", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Concurrent Editable Person" }, ACTOR));
    const comHabId = await programId("COM_HAB");
    const input = {
      individualId: person.id,
      programId: comHabId,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      periodType: "custom",
      authorizedHours: "100",
    };

    const results = await Promise.all([
      createProgramBudget(pool, { ...input, label: "Conversion A" }, ACTOR),
      createProgramBudget(pool, { ...input, label: "Conversion B" }, ACTOR),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "conflict")).toHaveLength(1);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM budget_periods WHERE individual_id = $1`,
      [person.id],
    )).rows[0]?.count).toBe("1");
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM budget_authorizations
        WHERE individual_id = $1 AND program_id = $2 AND status = 'active'`,
      [person.id, comHabId],
    )).rows[0]?.count).toBe("1");
  });

  it("prefers explicit current budgets, reduces fallback duplicates, and excludes inactive cohorts", async () => {
    const explicitPerson = unwrap(await createIndividual(pool, { displayName: "Explicit Current Person" }, ACTOR));
    const fallbackPerson = unwrap(await createIndividual(pool, { displayName: "Fallback Current Person" }, ACTOR));
    const inactivePerson = unwrap(await createIndividual(pool, { displayName: "Inactive Current Person" }, ACTOR));
    const calendarPerson = unwrap(await createIndividual(pool, { displayName: "Calendar Policy Person" }, ACTOR));
    const comHabId = await programId("COM_HAB");
    const calendarProgram = await pool.query<{ id: string }>(
      `INSERT INTO programs (code, name, renewal_policy)
       VALUES ('CALENDAR_POLICY_TEST', 'Calendar policy test', 'calendar')
       RETURNING id`,
    );
    const calendarProgramId = calendarProgram.rows[0]!.id;

    unwrap(await createProgramBudget(pool, {
      individualId: explicitPerson.id,
      programId: comHabId,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      periodType: "custom",
      authorizedHours: "120",
    }, ACTOR));

    async function addStrategy(
      individualId: string,
      label: string,
      sortOrder: number,
      hours: string,
      selectedProgramId = comHabId,
    ): Promise<string> {
      const strategy = await pool.query<{ id: string }>(
        `INSERT INTO calculation_strategies
           (individual_id, label, renewal_date, status, sort_order)
         VALUES ($1, $2, '2027-01-01', 'active', $3)
         RETURNING id`,
        [individualId, label, sortOrder],
      );
      await pool.query(
        `INSERT INTO calculation_strategy_lines (strategy_id, program_id, authorized_hours)
         VALUES ($1, $2, $3)`,
        [strategy.rows[0]!.id, selectedProgramId, hours],
      );
      return strategy.rows[0]!.id;
    }

    await addStrategy(explicitPerson.id, "Legacy plan", 0, "999");
    await addStrategy(fallbackPerson.id, "Primary plan", 1, "80");
    await addStrategy(fallbackPerson.id, "Duplicate plan", 2, "40");
    await addStrategy(inactivePerson.id, "Inactive plan", 1, "60");
    const calendarStrategyId = await addStrategy(
      calendarPerson.id,
      "Calendar plan",
      1,
      "30",
      calendarProgramId,
    );
    await pool.query(`UPDATE individuals SET status = 'inactive' WHERE id = $1`, [inactivePerson.id]);

    const current = await listCurrentProgramBudgets(pool, { asOf: "2026-08-31" });
    expect(current.filter((row) => row.individualId === explicitPerson.id)).toEqual([
      expect.objectContaining({
        authorizedHours: "120.0000",
        isExplicit: true,
        sourceCandidateCount: 1,
      }),
    ]);
    expect(current.filter((row) => row.individualId === fallbackPerson.id)).toEqual([
      expect.objectContaining({
        authorizedHours: "80.0000",
        isExplicit: false,
        source: "calculation_strategy",
        sourceCandidateCount: 2,
      }),
    ]);
    expect(current.some((row) => row.individualId === inactivePerson.id)).toBe(false);
    expect(current.find((row) => row.programId === calendarProgramId)).toMatchObject({
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      renewalDate: "2027-01-01",
      authorizedHours: "30.0000",
      isExplicit: false,
    });

    await pool.query(`UPDATE programs SET is_active = false WHERE id = $1`, [comHabId]);
    try {
      const withoutInactiveProgram = await listCurrentProgramBudgets(pool, { asOf: "2026-08-31" });
      expect(withoutInactiveProgram.some((row) => row.programId === comHabId)).toBe(false);
    } finally {
      await pool.query(`UPDATE programs SET is_active = true WHERE id = $1`, [comHabId]);
    }
    await pool.query(`DELETE FROM calculation_strategies WHERE id = $1`, [calendarStrategyId]);
    await pool.query(`DELETE FROM programs WHERE id = $1`, [calendarProgramId]);
  });

  it("keeps Classes as a sole-writer program", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Classes Sole Writer" }, ACTOR));
    const result = await createProgramBudget(pool, {
      individualId: person.id,
      programId: await programId("CLASSES"),
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      periodType: "custom",
      authorizedDollars: "1000",
    }, ACTOR);
    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM budget_periods WHERE individual_id = $1`,
      [person.id],
    )).rows[0]?.count).toBe("0");

    const classBudget = unwrap(await createClassBudget(pool, {
      individualId: person.id,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      authorizedAmount: "1000",
    }, ACTOR));
    const link = (await pool.query<{
      budget_period_id: string;
      budget_authorization_id: string;
      program_id: string;
    }>(
      `SELECT budget_period_id, budget_authorization_id, program_id
         FROM class_budget_periods WHERE id = $1`,
      [classBudget.id],
    )).rows[0]!;
    expect(await createProgramBudgetEvent(pool, {
      budgetPeriodId: link.budget_period_id,
      programId: link.program_id,
      eventType: "adjust",
      serviceDate: "2026-08-01",
      amount: "10",
      sourceId: "GENERIC-CLASS-ADJUSTMENT",
      note: "Disallowed generic adjustment",
    }, ACTOR)).toMatchObject({ ok: false, code: "conflict" });
    expect(await reviseAuthorization(pool, link.budget_authorization_id, {
      authorizedDollars: "1200",
    }, ACTOR, "Disallowed generic revision")).toMatchObject({ ok: false, code: "conflict" });
    expect(await cancelAuthorization(
      pool,
      link.budget_authorization_id,
      ACTOR,
      "Disallowed generic cancellation",
    )).toMatchObject({ ok: false, code: "conflict" });

    unwrap(await updateClassBudget(
      pool,
      classBudget.id,
      { authorizedAmount: "1200" },
      ACTOR,
      "Approved class allowance revision",
    ));
    const revisedLink = (await pool.query<{ budget_authorization_id: string }>(
      `SELECT budget_authorization_id FROM class_budget_periods WHERE id = $1`,
      [classBudget.id],
    )).rows[0]!.budget_authorization_id;
    expect(revisedLink).not.toBe(link.budget_authorization_id);
    expect((await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM budget_authorizations
        WHERE id = ANY($1::uuid[]) ORDER BY revision`,
      [[link.budget_authorization_id, revisedLink]],
    )).rows).toEqual([
      { id: link.budget_authorization_id, status: "superseded" },
      { id: revisedLink, status: "active" },
    ]);
  });

  it("rolls back a class update when its canonical authorization link is missing", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Broken Class Bridge" }, ACTOR));
    const classBudget = unwrap(await createClassBudget(pool, {
      individualId: person.id,
      label: "Original label",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      authorizedAmount: "1000",
    }, ACTOR));
    await pool.query(
      `UPDATE class_budget_periods SET budget_authorization_id = NULL WHERE id = $1`,
      [classBudget.id],
    );
    await expect(updateClassBudget(
      pool,
      classBudget.id,
      { label: "Must not persist" },
      ACTOR,
      "Testing a broken canonical link",
    )).rejects.toThrow(/canonical program authorization link/i);
    expect((await pool.query<{ label: string }>(
      `SELECT label FROM class_budget_periods WHERE id = $1`,
      [classBudget.id],
    )).rows[0]?.label).toBe("Original label");
  });
});
