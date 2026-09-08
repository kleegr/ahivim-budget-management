import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listCurrentProgramBudgets, listProgramBudgets, listProgramBudgetMonthlyHistory } from "@/lib/data/program-budgets";
import type { PgLikePool } from "@/lib/import/commit";
import { createIndividual } from "@/lib/manage/individuals";
import { getBudgetPeriod, updateBudgetPeriodRenewal } from "@/lib/manage/authorizations";
import { createProgramBudget, createProgramBudgetEvent, reverseProgramBudgetEvent } from "@/lib/manage/program-budgets";
import { createStrategy, updateStrategy, listStrategies, listProgramRates, explainStrategy } from "@/lib/manage/calculation-strategies";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

async function manualBudget() {
  const person = unwrap(await createIndividual(pool, { displayName: "Budget integrity example" }, ACTOR));
  const program = await pool.query<{ id: string }>(
    `INSERT INTO programs (code, name, required_auth_type, consumption_source)
     VALUES ($1, 'Manual allowance example', 'dollars', 'manual') RETURNING id`,
    [`B_MANUAL_${randomUUID()}`],
  );
  return unwrap(await createProgramBudget(pool, {
    individualId: person.id, programId: program.rows[0]!.id,
    renewalDate: "2027-01-01", authorizedDollars: "1000",
  }, ACTOR));
}

suite("Developer 1 budget and Financial Setup integrity (PostgreSQL)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES ($1, 'budget-integrity@example.test', 'Budget test operator', 'x', 'admin')`, [ACTOR],
    );
  });
  afterAll(closeTestPool);

  it("replays concurrent near-limit posts without counting them twice or requiring a new override", async () => {
    const budget = await manualBudget();
    const input = {
      budgetPeriodId: budget.budgetPeriodId, programId: budget.programId,
      serviceDate: "2026-08-15", amount: "600", sourceId: "retry-example",
    };
    const [first, retry] = (await Promise.all([
      createProgramBudgetEvent(pool, input, ACTOR), createProgramBudgetEvent(pool, input, ACTOR),
    ])).map(unwrap);
    expect(retry.id).toBe(first.id);
    expect((await listProgramBudgets(pool, { individualId: budget.individualId }))[0]).toMatchObject({
      consumedDollars: "600.0000", remainingDollars: "400.0000",
    });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
        WHERE action = 'program_budget_event_created' AND entity_id = $1`, [first.id],
    )).rows[0]?.count).toBe("1");
    expect(await createProgramBudgetEvent(pool, { ...input, amount: "601" }, ACTOR))
      .toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("different budget event") });
  });

  it("returns immutable retry evidence after a period closes and after a reversal", async () => {
    const budget = await manualBudget();
    const input = {
      budgetPeriodId: budget.budgetPeriodId, programId: budget.programId,
      serviceDate: "2026-08-15", amount: "1000", sourceId: "closed-retry-example",
    };
    const event = unwrap(await createProgramBudgetEvent(pool, input, ACTOR));
    unwrap(await reverseProgramBudgetEvent(pool, event.id, ACTOR, "Original entry was corrected"));
    await pool.query(`UPDATE budget_periods SET status = 'closed' WHERE id = $1`, [budget.budgetPeriodId]);
    expect(unwrap(await createProgramBudgetEvent(pool, input, ACTOR)).id).toBe(event.id);
    expect((await listProgramBudgets(pool, { individualId: budget.individualId }))[0]).toMatchObject({
      consumedDollars: "0.0000", remainingDollars: "1000.0000",
    });
  });

  it("keeps the prior period intact when next year's renewal is requested", async () => {
    const budget = await manualBudget();
    expect(await updateBudgetPeriodRenewal(pool, budget.budgetPeriodId, "2028-01-01", ACTOR, "Next annual approval"))
      .toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("new budget period") });
    const next = unwrap(await createProgramBudget(pool, {
      individualId: budget.individualId, programId: budget.programId,
      renewalDate: "2028-01-01", authorizedDollars: "1100",
    }, ACTOR, "Approved next annual allowance"));
    expect(next.budgetPeriodId).not.toBe(budget.budgetPeriodId);
    expect(await getBudgetPeriod(pool, budget.budgetPeriodId)).toMatchObject({
      startDate: "2026-01-01", endDate: "2026-12-31", renewalDate: "2027-01-01",
    });
    expect(await listProgramBudgets(pool, { individualId: budget.individualId })).toHaveLength(2);
  });

  it("rejects date corrections that would strand immutable event history outside the period", async () => {
    const budget = await manualBudget();
    unwrap(await createProgramBudgetEvent(pool, {
      budgetPeriodId: budget.budgetPeriodId, programId: budget.programId,
      serviceDate: "2026-01-15", amount: "200", sourceId: "january-history-example",
    }, ACTOR));
    expect(await updateBudgetPeriodRenewal(pool, budget.budgetPeriodId, "2027-02-01", ACTOR, "Changed source renewal"))
      .toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("exclude recorded budget events") });
    expect(await getBudgetPeriod(pool, budget.budgetPeriodId)).toMatchObject({ startDate: "2026-01-01" });
  });

  it("permits an audited date correction when recorded activity stays inside the period", async () => {
    const budget = await manualBudget();
    unwrap(await createProgramBudgetEvent(pool, {
      budgetPeriodId: budget.budgetPeriodId, programId: budget.programId,
      serviceDate: "2026-08-15", amount: "200", sourceId: "august-history-example",
    }, ACTOR));
    unwrap(await updateBudgetPeriodRenewal(pool, budget.budgetPeriodId, "2027-02-01", ACTOR, "Corrected from signed authorization"));
    expect((await listProgramBudgets(pool, { individualId: budget.individualId }))[0]).toMatchObject({
      startDate: "2026-02-01", consumedDollars: "200.0000",
    });
    const audit = await pool.query<{ metadata: { previous: { startDate: string }; next: { startDate: string } } }>(
      `SELECT metadata FROM audit_logs WHERE action = 'budget_period_renewal_updated' AND entity_id = $1`, [budget.budgetPeriodId],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ previous: { startDate: "2026-01-01" }, next: { startDate: "2026-02-01" } });
  });

  it.each([
    { source: "payroll", periodBegin: "2026-01-15", checkDate: "2026-08-15", periodEnd: null, renewal: "2027-02-01" },
    { source: "mixed", periodBegin: "2026-01-15", checkDate: null, periodEnd: null, renewal: "2027-02-01" },
    { source: "payroll", periodBegin: null, checkDate: "2026-12-15", periodEnd: null, renewal: "2026-12-01" },
    { source: "mixed", periodBegin: null, checkDate: null, periodEnd: "2026-12-15", renewal: "2026-12-01" },
  ])("preserves $source payroll history when a date correction excludes its canonical service date", async (example) => {
    const budget = await manualBudget();
    await pool.query("UPDATE programs SET consumption_source = $2 WHERE id = $1", [budget.programId, example.source]);
    const transaction = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_transactions
         (individual_id, program_id, period_begin, check_date, period_end, imported_hours,
          imported_amount, transaction_fingerprint)
       VALUES ($1, $2, $3, $4, $5, 2, 200, $6) RETURNING id`,
      [budget.individualId, budget.programId, example.periodBegin, example.checkDate, example.periodEnd, randomUUID()],
    )).rows[0]!.id;
    const beforePeriod = await getBudgetPeriod(pool, budget.budgetPeriodId);
    const beforeBudget = (await listProgramBudgets(pool, { individualId: budget.individualId }))[0];
    const beforeHistory = await listProgramBudgetMonthlyHistory(pool, budget.budgetPeriodId, budget.programId, new Date("2027-01-01T12:00:00Z"));
    const beforeSource = (await pool.query("SELECT to_jsonb(payroll) AS source FROM payroll_transactions payroll WHERE id = $1", [transaction])).rows[0];
    expect(beforeBudget).toMatchObject({ consumedHours: "2.0000", consumedDollars: "200.0000", remainingDollars: "800.0000" });

    expect(await updateBudgetPeriodRenewal(pool, budget.budgetPeriodId, example.renewal, ACTOR, "Changed source renewal"))
      .toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("exclude recorded payroll usage") });
    expect(await getBudgetPeriod(pool, budget.budgetPeriodId)).toEqual(beforePeriod);
    expect((await listProgramBudgets(pool, { individualId: budget.individualId }))[0]).toEqual(beforeBudget);
    expect(await listProgramBudgetMonthlyHistory(pool, budget.budgetPeriodId, budget.programId, new Date("2027-01-01T12:00:00Z"))).toEqual(beforeHistory);
    expect((await pool.query("SELECT to_jsonb(payroll) AS source FROM payroll_transactions payroll WHERE id = $1", [transaction])).rows[0]).toEqual(beforeSource);
    expect((await pool.query("SELECT id FROM audit_logs WHERE action = 'budget_period_renewal_updated' AND entity_id = $1", [budget.budgetPeriodId])).rows).toHaveLength(0);
  });

  it("allows payroll date corrections when that period's recorded usage stays inside its dates", async () => {
    const budget = await manualBudget();
    await pool.query("UPDATE programs SET consumption_source = 'payroll' WHERE id = $1", [budget.programId]);
    for (const serviceDate of ["2026-08-15", "2025-01-15"]) {
      await pool.query(
        `INSERT INTO payroll_transactions
           (individual_id, program_id, period_begin, imported_hours, imported_amount, transaction_fingerprint)
         VALUES ($1, $2, $3, 2, 200, $4)`,
        [budget.individualId, budget.programId, serviceDate, randomUUID()],
      );
    }
    unwrap(await updateBudgetPeriodRenewal(pool, budget.budgetPeriodId, "2027-02-01", ACTOR, "Corrected signed authorization dates"));
    expect((await listProgramBudgets(pool, { individualId: budget.individualId }))[0]).toMatchObject({
      startDate: "2026-02-01", consumedHours: "2.0000", consumedDollars: "200.0000", remainingDollars: "800.0000",
    });
  });

  it("waits for a concurrent payroll import before checking renewal history and locks sources before the period", async () => {
    const budget = await manualBudget();
    await pool.query("UPDATE programs SET consumption_source = 'payroll' WHERE id = $1", [budget.programId]);
    const beforePeriod = await getBudgetPeriod(pool, budget.budgetPeriodId);
    const writer = await pool.connect();
    const renewalClient = await pool.connect();
    const renewalPid = (await renewalClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    let renewal: ReturnType<typeof updateBudgetPeriodRenewal> | undefined;
    try {
      await writer.query("BEGIN");
      // The real database source trigger takes the same advisory lock as an
      // import. This uncommitted January usage is invisible to other readers.
      await writer.query(
        `INSERT INTO payroll_transactions
           (individual_id, program_id, period_begin, imported_hours, imported_amount, transaction_fingerprint)
         VALUES ($1, $2, '2026-01-15', 2, 200, $3)`,
        [budget.individualId, budget.programId, randomUUID()],
      );
      renewal = updateBudgetPeriodRenewal({
        query: pool.query.bind(pool), connect: async () => renewalClient,
      }, budget.budgetPeriodId, "2027-02-01", ACTOR, "Concurrent authorization correction");

      await expect.poll(async () => (await pool.query<{ waiting: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_locks
                        WHERE pid = $1 AND locktype = 'advisory' AND NOT granted) AS waiting`,
        [renewalPid],
      )).rows[0]!.waiting, { timeout: 5_000 }).toBe(true);
      // A renewal waiting for sources must not hold the budget row first.
      await expect(pool.query(
        "SELECT id FROM budget_periods WHERE id = $1 FOR UPDATE NOWAIT", [budget.budgetPeriodId],
      )).resolves.toMatchObject({ rowCount: 1 });
      await writer.query("COMMIT");

      expect(await renewal).toMatchObject({
        ok: false, code: "conflict", message: expect.stringContaining("exclude recorded payroll usage"),
      });
      expect(await getBudgetPeriod(pool, budget.budgetPeriodId)).toEqual(beforePeriod);
      expect((await listProgramBudgets(pool, { individualId: budget.individualId }))[0]).toMatchObject({
        consumedHours: "2.0000", consumedDollars: "200.0000", remainingDollars: "800.0000",
      });
      expect((await pool.query(
        "SELECT id FROM audit_logs WHERE action = 'budget_period_renewal_updated' AND entity_id = $1", [budget.budgetPeriodId],
      )).rows).toHaveLength(0);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      if (renewal) await renewal;
      else renewalClient.release();
    }
  });

  it("stores sub-one-percent cuts, a seven-month basis, and an explicit approved zero without inventing a date", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Financial setup example" }, ACTOR));
    const strategy = unwrap(await createStrategy(pool, { individualId: person.id }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: strategy.id, monthDivisor: "7", cut1Percent: "1%", cut2Percent: "0.5%", afterAll: "0",
    }, ACTOR, "Approved low-percentage arrangement"));
    expect((await listStrategies(pool, { individualId: person.id, asOf: "2026-09-01" })).rows[0]).toMatchObject({
      renewalDate: null, monthDivisor: "7.000", cut1Percent: "0.010000", cut2Percent: "0.005000", afterAll: "0.0000",
    });
  });

  it("does not use archived rates in setup, details, or program defaults", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Archived rate example" }, ACTOR));
    const program = (await pool.query<{ id: string }>(
      `INSERT INTO programs (code, name) VALUES ($1, 'Rate example') RETURNING id`, [`B_RATE_${randomUUID()}`],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO program_rate_schedules (program_id, effective_from, internal_rate, archived_at)
       VALUES ($1, '2020-01-01', 20, NULL), ($1, '2026-01-01', 99, now())`, [program],
    );
    const strategy = unwrap(await createStrategy(pool, { individualId: person.id }, ACTOR));
    unwrap(await updateStrategy(pool, { id: strategy.id, renewalDate: "2027-01-01", hours: { [program]: "120" } }, ACTOR));
    expect((await listProgramRates(pool, "2026-09-01")).find((row) => row.id === program)?.internalRate).toBe("20.0000");
    expect((await listStrategies(pool, { individualId: person.id, asOf: "2026-09-01" })).rows[0]?.monthlyGross).toBe("200.0000");
    expect((await explainStrategy(pool, strategy.id))?.monthlyGross).toBe("200.0000");
  });

  it("uses confirmed group credits consistently without inventing links for review rows or dates for undated rows", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Group credit example" }, ACTOR));
    const partner = unwrap(await createIndividual(pool, { displayName: "Group partner example" }, ACTOR));
    const program = (await pool.query<{ id: string }>(`SELECT id FROM programs WHERE code = 'DAY_HAB'`)).rows[0]!.id;
    const budget = unwrap(await createProgramBudget(pool, {
      individualId: person.id, programId: program, renewalDate: "2027-01-01",
      authorizedHours: "100", individualRateOverride: "20",
    }, ACTOR));
    const strategy = unwrap(await createStrategy(pool, { individualId: person.id }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: strategy.id, renewalDate: "2027-01-01", hours: { [program]: "100" }, rateOverrides: { [program]: "20" },
    }, ACTOR));

    for (const [status, serviceDate] of [["confirmed", "2026-08-10"], ["needs_review", "2026-08-11"], ["confirmed", null]] as const) {
      const session = (await pool.query<{ id: string }>(
        `INSERT INTO service_sessions
           (program_id, physical_hours, group_size, combined_rate, combined_amount, base_individual_rate, group_detection_status)
         VALUES ($1, 2, 2, 34, 68, 17, $2) RETURNING id`, [program, status],
      )).rows[0]!.id;
      for (const individualId of [person.id, partner.id]) {
        const transaction = (await pool.query<{ id: string }>(
          `INSERT INTO payroll_transactions
             (individual_id, program_id, period_begin, imported_hours, imported_amount,
              calculated_internal_amount, transaction_fingerprint)
           VALUES ($1, $2, $3, 2, 34, 34, $4) RETURNING id`,
          [individualId, program, serviceDate, randomUUID()],
        )).rows[0]!.id;
        await pool.query(
          `INSERT INTO service_allocations
             (service_session_id, individual_id, payroll_transaction_id, allocation_hours, allocated_rate, allocated_amount)
           VALUES ($1, $2, $3, 2, 17, 34)`, [session, individualId, transaction],
        );
      }
    }

    const expected = { consumedHours: "3.7000", remainingHours: "96.3000", undatedUsageCount: 1 };
    expect((await listProgramBudgets(pool, { individualId: person.id }))[0]).toMatchObject(expected);
    expect((await listCurrentProgramBudgets(pool, { individualId: person.id, asOf: "2026-09-01" }))[0]).toMatchObject(expected);
    const months = await listProgramBudgetMonthlyHistory(pool, budget.budgetPeriodId, program, new Date("2026-09-01T12:00:00Z"));
    expect(months.find((month) => month.month === "2026-08")).toMatchObject({ usedHours: "3.7000", remainingHours: "96.3000" });
    expect((await listStrategies(pool, { individualId: person.id, asOf: "2026-09-01", withAnalytics: true })).rows[0]?.analytics)
      .toMatchObject({ actualHours: "3.7000", remainingHours: "96.3000", actualInternal: "68.0000" });
  });
});
