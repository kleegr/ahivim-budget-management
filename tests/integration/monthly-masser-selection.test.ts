import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fullAccess } from "@/lib/auth/access";
import { reservePresentation } from "@/lib/business/reserve-presentation";
import { getCollectionsWorkspace, getIndividualMasserStatement } from "@/lib/data/direct-pay-operations";
import type { PgLikePool } from "@/lib/import/commit";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const scope = fullAccess("00000000-0000-4000-8000-000000009001", "admin");
let pool: PgLikePool;

suite("selected monthly Masser plans beside preserved historical holds", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query("UPDATE settlement_ledger_state SET blocked_obligation_ids = '{}'::uuid[], source_review_count = 0, source_review_summary = NULL");
  });
  afterAll(closeTestPool);

  async function seed(month = "2026-09") {
    const individualId = (await pool.query<{ id: string }>(`INSERT INTO individuals (display_name, normalized_name)
      VALUES ('Synthetic monthly person', 'synthetic monthly person') RETURNING id`)).rows[0]!.id;
    const strategyId = (await pool.query<{ id: string }>(`INSERT INTO calculation_strategies
      (individual_id, label, after_all, month_divisor, renewal_date, created_at, updated_at)
      VALUES ($1, 'Synthetic monthly approval', 100, 12, '2027-09-15', '2026-08-01', '2026-08-01') RETURNING id`, [individualId])).rows[0]!.id;
    const insert = async (kind: string, amount: string, begin: string, end: string, metadata: object) =>
      (await pool.query<{ id: string }>(`INSERT INTO settlement_obligations
        (source_key, kind, direction, individual_id, calculation_strategy_id, original_amount, period_begin, period_end, calculation_metadata)
        VALUES (gen_random_uuid()::text, $1, 'reserve', $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
      [kind, individualId, strategyId, amount, begin, end, JSON.stringify({ flow: "individual_plan", ...metadata })])).rows[0]!.id;
    const annualId = await insert("individual_masser", "1200", "2026-09-15", "2027-09-15", {});
    const nextMonth = month === "2026-09" ? "2026-10" : "2026-11";
    const monthlyId = await insert("individual_masser", "100", `${month}-01`, `${nextMonth}-01`, {
      amountBasis: "monthly", monthlyAmount: "100", monthDivisor: "1", calculationMonthDivisor: "12",
    });
    // Same-window explanatory roots must not join the canonical monthly item.
    await insert("individual_cut_1", "50", `${month}-01`, `${nextMonth}-01`, {});
    await pool.query(`INSERT INTO settlement_events (settlement_obligation_id, individual_id, event_type, amount, occurred_on)
      VALUES ($1, $3, 'set_aside', 20, '2026-09-08'), ($2, $3, 'set_aside', 30, $4)`,
    [annualId, monthlyId, individualId, `${month}-08`]);
    await pool.query(`UPDATE settlement_ledger_state SET refreshed_version = source_version,
      dirty_since = NULL, refreshed_for_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date`);
    return { individualId, annualId, monthlyId };
  }

  it("prefers the calendar month over a later-starting held annual period without altering old records", async () => {
    const seeded = await seed();
    const before = (await pool.query("SELECT to_jsonb(o) AS row FROM settlement_obligations o ORDER BY id")).rows;
    const data = await getCollectionsWorkspace(pool, scope, "2026-09");
    expect(data.individualSetAsides[0]).toMatchObject({ approvedMonthlyPlan: "100.0000",
      remainingSetAside: "70.0000", setAsideThisMonth: "30.0000", trackedPlans: 1,
      actionablePlans: 1, reviewRequiredPlans: 0, historicalReviewRequiredPlans: 1 });
    const statement = (await getIndividualMasserStatement(pool, scope, seeded.individualId, "2026-09"))!;
    expect(statement).toMatchObject({ recordedReserve: "30.0000", remainingReserve: "70.0000", availableCredit: "0.0000",
      actionablePlans: 1, reviewRequiredPlans: 0, historicalReviewRequiredPlans: 1,
      history: [{ month: "2026-09", setAside: "30.0000" }] });
    expect(reservePresentation(statement).display(statement.remainingReserve)).toBe("$70.00");
    expect((await pool.query("SELECT to_jsonb(o) AS row FROM settlement_obligations o ORDER BY id")).rows).toEqual(before);
    expect((await pool.query<{ amount: string }>("SELECT sum(amount)::text AS amount FROM settlement_events WHERE settlement_obligation_id = $1", [seeded.annualId])).rows[0]!.amount).toBe("20.0000");
  });

  it("keeps the selected month held when the verified monthly item belongs to another month", async () => {
    const seeded = await seed("2026-10");
    const data = await getCollectionsWorkspace(pool, scope, "2026-09");
    expect(data.individualSetAsides[0]).toMatchObject({ remainingSetAside: "0.0000", setAsideThisMonth: "20.0000",
      actionablePlans: 0, reviewRequiredPlans: 1 });
    const statement = (await getIndividualMasserStatement(pool, scope, seeded.individualId, "2026-09"))!;
    expect(statement).toMatchObject({ remainingReserve: "0.0000", actionablePlans: 0, reviewRequiredPlans: 1,
      history: [{ month: "2026-09", setAside: "20.0000" }] });
    expect(reservePresentation(statement).display(statement.remainingReserve)).toBe("Unavailable");
  });

  it("does not expose another person's historical hold counts to a direct grant", async () => {
    const seeded = await seed();
    const restricted = { ...scope, full: false, allIndividuals: false, allEmployees: false,
      individualIds: [seeded.individualId], grantedIndividualIds: [], employeeIds: [], grantedEmployeeIds: [] };
    expect((await getCollectionsWorkspace(pool, restricted, "2026-09")).individualSetAsides).toEqual([]);
    expect(await getIndividualMasserStatement(pool, restricted, seeded.individualId, "2026-09")).toBeNull();
  });
});
