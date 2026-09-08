import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fullAccess } from "@/lib/auth/access";
import { getCollectionsWorkspace, getIndividualMasserStatement, getPayrollCheckCounts, listPayrollChecks } from "@/lib/data/direct-pay-operations";
import { individualPutAwayReport, REPORTS } from "@/lib/data/report-queries";
import { reservePresentation } from "@/lib/business/reserve-presentation";
import type { PgLikePool } from "@/lib/import/commit";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const OWNER = "00000000-0000-4000-8000-000000009001";
const scope = fullAccess(OWNER, "admin");
let pool: PgLikePool;

suite("Masser source-review read integrity (PostgreSQL)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query("UPDATE settlement_ledger_state SET blocked_obligation_ids = '{}'::uuid[], source_review_count = 0, source_review_summary = NULL");
  });
  afterAll(closeTestPool);

  async function person(name: string) {
    return (await pool.query<{ id: string }>("INSERT INTO individuals (display_name, normalized_name) VALUES ($1, lower($1)) RETURNING id", [name])).rows[0]!.id;
  }
  async function strategy(individualId: string, amount: string, divisor: string) {
    return (await pool.query<{ id: string }>(`INSERT INTO calculation_strategies
      (individual_id, label, after_all, month_divisor, renewal_date, created_at, updated_at)
      VALUES ($1, 'Synthetic approved source', $2, $3, '2027-01-01', '2026-08-01', '2026-08-01') RETURNING id`,
    [individualId, amount, divisor])).rows[0]!.id;
  }
  async function root(individualId: string, strategyId: string, amount: string, kind = "individual_masser", metadata: Record<string, unknown> = {}, begin = "2026-01-01") {
    return (await pool.query<{ id: string }>(`INSERT INTO settlement_obligations
      (source_key, kind, direction, individual_id, calculation_strategy_id, original_amount, period_begin, period_end, calculation_metadata)
      VALUES (gen_random_uuid()::text, $1, 'reserve', $2, $3, $4, $5, '2027-01-01', $6::jsonb) RETURNING id`,
    [kind, individualId, strategyId, amount, begin, JSON.stringify({ flow: "individual_plan", ...metadata })])).rows[0]!.id;
  }
  async function cash(individualId: string, obligationId: string, amount: string) {
    await pool.query(`INSERT INTO settlement_events (settlement_obligation_id, individual_id, event_type, amount, occurred_on)
      VALUES ($1, $2, 'set_aside', $3, '2026-09-08')`, [obligationId, individualId, amount]);
  }
  async function mixed(heldPayment = "20") {
    const id = await person("Synthetic mixed individual");
    const known = await strategy(id, "100", "1"), held = await strategy(id, "200", "12");
    const knownRoot = await root(id, known, "100", undefined, { monthlyAmount: "100", monthDivisor: "1" });
    const heldRoot = await root(id, held, "2400", undefined, { monthlyAmount: null });
    const legacy = await root(id, held, "50", "individual_cut_1");
    await cash(id, knownRoot, "30"); await cash(id, heldRoot, heldPayment); await cash(id, legacy, "5");
    return { id, known, held, knownRoot, heldRoot, legacy };
  }
  async function controls() {
    const result: Record<string, unknown> = {};
    for (const table of ["settlement_obligations", "settlement_events", "calculation_strategies", "audit_logs"]) {
      result[table] = (await pool.query(`SELECT count(*)::int AS count,
        md5(COALESCE(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text), '')) AS hash FROM ${table} t`)).rows[0];
    }
    return result;
  }
  async function markFixtureProcessed() {
    // Isolated read-model fixture only; the source-review predicate remains
    // authoritative even when no persisted holds have been populated yet.
    await pool.query(`UPDATE settlement_ledger_state SET refreshed_version = source_version,
      dirty_since = NULL, refreshed_for_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date`);
  }

  it("excludes unsupported legacy amounts before refresh while retaining monthly approval and all actual cash", async () => {
    const seeded = await mixed(); const before = await controls();
    const data = await getCollectionsWorkspace(pool, scope, "2026-09");
    expect(data.individualSetAsides).toEqual([expect.objectContaining({ individualId: seeded.id,
      approvedMonthlyPlan: "300.0000", setAsideThisMonth: "55.0000", remainingSetAside: "70.0000",
      trackedPlans: 2, actionablePlans: 1, reviewRequiredPlans: 1 })]);
    expect(data.summary.approvedMonthlySetAside).toBe("300.0000");
    expect(data.ledgerDirty).toBe(true);
    const statement = await getIndividualMasserStatement(pool, scope, seeded.id, "2026-09");
    expect(statement).toMatchObject({ approvedMonthlyPlan: "300.0000", recordedReserve: "55.0000",
      remainingReserve: "70.0000", availableCredit: "0.0000", actionablePlans: 1, reviewRequiredPlans: 1,
      history: [{ month: "2026-09", setAside: "55.0000" }] });
    expect(await controls()).toEqual(before);
  });

  it("retains overpaid held cash without advertising that unsupported balance as available credit", async () => {
    const seeded = await mixed("2500"); const before = await controls();
    await pool.query("UPDATE settlement_ledger_state SET blocked_obligation_ids = ARRAY[$1::uuid]", [seeded.heldRoot]);
    const statement = await getIndividualMasserStatement(pool, scope, seeded.id, "2026-09");
    expect(statement).toMatchObject({ recordedReserve: "2535.0000", remainingReserve: "70.0000", availableCredit: "0.0000",
      actionablePlans: 1, reviewRequiredPlans: 1, history: [{ month: "2026-09", setAside: "2535.0000" }] });
    expect(await controls()).toEqual(before);
  });

  it("holds the complete corrected balance when a retained correction alone needs source review", async () => {
    const id = await person("Synthetic correction individual"), plan = await strategy(id, "100", "1");
    const original = await root(id, plan, "100", undefined, { monthlyAmount: "100", monthDivisor: "1" });
    const correction = await root(id, plan, "25", "individual_masser_correction", {
      adjustmentForObligationId: original, recalculatedDirection: "reserve", recalculatedOriginalAmount: "125",
    });
    await cash(id, original, "20");
    await pool.query("UPDATE settlement_ledger_state SET blocked_obligation_ids = ARRAY[$1::uuid]", [correction]);
    const data = await getCollectionsWorkspace(pool, scope, "2026-09");
    expect(data.individualSetAsides[0]).toMatchObject({ remainingSetAside: "0.0000", setAsideThisMonth: "20.0000",
      trackedPlans: 1, actionablePlans: 0, reviewRequiredPlans: 1 });
  });

  it("does not substitute an older eligible period when the selected latest period is held", async () => {
    const id = await person("Synthetic latest-period individual"), plan = await strategy(id, "100", "1");
    const old = await root(id, plan, "100", undefined, { monthlyAmount: "100", monthDivisor: "1" });
    const latest = await root(id, plan, "1200", undefined, {}, "2026-08-01");
    await cash(id, old, "30"); await cash(id, latest, "20");
    const data = await getCollectionsWorkspace(pool, scope, "2026-09");
    expect(data.individualSetAsides[0]).toMatchObject({ approvedMonthlyPlan: "100.0000", setAsideThisMonth: "20.0000",
      remainingSetAside: "0.0000", trackedPlans: 1, actionablePlans: 0, reviewRequiredPlans: 1 });
    expect(await getIndividualMasserStatement(pool, scope, id, "2026-09")).toMatchObject({ recordedReserve: "20.0000",
      remainingReserve: "0.0000", actionablePlans: 0, reviewRequiredPlans: 1 });
  });

  it("keeps review counts and statement records within direct individual grants", async () => {
    const visible = await mixed(), hidden = await person("Hidden connected individual");
    const hiddenPlan = await strategy(hidden, "999", "12"); await root(hidden, hiddenPlan, "11988");
    const scoped = { ...scope, full: false, allIndividuals: false, allEmployees: false,
      individualIds: [visible.id, hidden], grantedIndividualIds: [visible.id], employeeIds: [], grantedEmployeeIds: [] };
    const data = await getCollectionsWorkspace(pool, scoped, "2026-09");
    expect(data.individualSetAsides.map(row => row.individualId)).toEqual([visible.id]);
    expect(data.individualSetAsides[0]!.reviewRequiredPlans).toBe(1);
    expect(JSON.stringify(data)).not.toContain("Hidden connected");
    expect(await getIndividualMasserStatement(pool, scoped, hidden, "2026-09")).toBeNull();
  });

  it("keeps held zero-remaining plans out of complete reports and exports their review status", async () => {
    const id = await person("Synthetic held report individual"), plan = await strategy(id, "200", "12");
    const obligation = await root(id, plan, "2400"); await cash(id, obligation, "20");
    await markFixtureProcessed();
    expect((await individualPutAwayReport(pool, { month: "2026-09", status: "complete" })).rows).toEqual([]);
    const reviewed = await individualPutAwayReport(pool, { month: "2026-09", status: "review-required" });
    expect(reviewed.rows).toEqual([expect.objectContaining({ individualId: id, approvedMonthlyPlan: "200.0000",
      setAsideThisMonth: "20.0000", remainingSetAside: null, reviewRequiredPlans: 1 })]);
    const [table] = await REPORTS["individual-put-away"]!.run(pool, { month: "2026-09" });
    expect(table!.rows[0]).toMatchObject({ approvedMonthlyPlan: "200.0000", setAsideThisMonth: "20.0000",
      remainingSetAside: null, reviewRequiredPlans: 1, balanceStatus: "Source review required; held balances excluded" });
  });

  it("does not report a previously completed known plan as complete after a new source write", async () => {
    const id = await person("Synthetic stale-source individual"), plan = await strategy(id, "100", "1");
    const obligation = await root(id, plan, "100", undefined, { monthlyAmount: "100", monthDivisor: "1" });
    await cash(id, obligation, "100"); await markFixtureProcessed();
    expect((await individualPutAwayReport(pool, { month: "2026-09", status: "complete" })).rows).toHaveLength(1);
    await pool.query("UPDATE calculation_strategies SET after_all = 101 WHERE id = $1", [plan]);
    expect((await individualPutAwayReport(pool, { month: "2026-09", status: "complete" })).rows).toEqual([]);
    const [table] = await REPORTS["individual-put-away"]!.run(pool, { month: "2026-09" });
    expect(table!.rows[0]).toMatchObject({ balanceStatus: "Refresh needed", setAsideThisMonth: "100.0000" });
    expect(await getIndividualMasserStatement(pool, scope, id, "2026-09")).toMatchObject({ ledgerDirty: true, recordedReserve: "100.0000" });
  });

  it("keeps a verified zero or credit complete beside an explicit-zero setup with no obligation", async () => {
    const id = await person("Synthetic verified plus zero setup"), plan = await strategy(id, "100", "1");
    const zero = await strategy(id, "0", "12");
    await pool.query("UPDATE calculation_strategies SET renewal_date = NULL WHERE id = $1", [zero]);
    const obligation = await root(id, plan, "100", undefined, { monthlyAmount: "100", monthDivisor: "1" });
    await cash(id, obligation, "100"); await markFixtureProcessed();
    const statement = (await getIndividualMasserStatement(pool, scope, id, "2026-09"))!;
    expect(statement).toMatchObject({ activePlans: 2, actionablePlans: 1, expectedBalancePlans: 1, missingBalanceRenewalPlans: 0 });
    expect(reservePresentation(statement).display(statement.remainingReserve)).toBe("$0.00");
    expect((await individualPutAwayReport(pool, { month: "2026-09", status: "complete" })).rows).toHaveLength(1);
    await cash(id, obligation, "25"); await markFixtureProcessed();
    const credited = (await getIndividualMasserStatement(pool, scope, id, "2026-09"))!;
    expect(reservePresentation(credited).display(credited.availableCredit)).toBe("$25.00");
  });

  it("counts all scoped unverified checks independently of the 100-row or focused-check display", async () => {
    const employees = (await pool.query<{ id: string }>(`INSERT INTO employees (display_name, normalized_name)
      VALUES ('Synthetic visible employee', 'visible'), ('Synthetic hidden employee', 'hidden') RETURNING id`)).rows;
    const visible = employees[0]!.id, hidden = employees[1]!.id;
    await pool.query(`INSERT INTO employee_payroll_checks (employee_id, check_number, actual_gross, actual_net, verification_status)
      SELECT $1::uuid, 'visible-' || n, 120, 100, CASE WHEN n <= 105 THEN 'unverified' WHEN n <= 107 THEN 'verified' ELSE 'void' END
      FROM generate_series(1, 108) n`, [visible]);
    await pool.query(`INSERT INTO employee_payroll_checks (employee_id, check_number, actual_net)
      SELECT $1::uuid, 'hidden-' || n, 999 FROM generate_series(1, 7) n`, [hidden]);
    const scoped = { ...scope, full: false, allEmployees: false, grantedEmployeeIds: [visible], employeeIds: [visible, hidden] };
    expect(await getPayrollCheckCounts(pool, scope)).toEqual({ total: 115, unverified: 112 });
    expect(await getPayrollCheckCounts(pool, scoped)).toEqual({ total: 108, unverified: 105 });
    const list = await listPayrollChecks(pool, scoped);
    expect(list).toHaveLength(100); expect(list.every(row => row.employeeId === visible)).toBe(true);
    const focused = await getCollectionsWorkspace(pool, scoped, "2026-09", { payrollCheckId: list[0]!.id });
    expect(focused.payrollChecks).toHaveLength(1);
    expect(focused.payrollCheckCounts).toEqual({ total: 108, unverified: 105 });
    expect(await getPayrollCheckCounts(pool, { ...scoped, canSeeCheckGross: false, canSeeCheckNet: false, canSeeTaxes: false }))
      .toEqual({ total: 0, unverified: 0 });
  });
});
