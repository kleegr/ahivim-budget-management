import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { getPersonSettlementBalance, getSettlementDashboard, getSettlementSummary } from "@/lib/data/settlements";
import {
  applySettlementCredit, correctSettlementEvent, recordObligationPayment,
  refreshSettlementObligations, refundSettlementCredit, reverseSettlementEvent, settleObligations,
} from "@/lib/manage/settlements";
import { settlementApplicationDate } from "@/lib/manage/settlement-freshness";
import { createStrategy, listStrategies, updateStrategy } from "@/lib/manage/calculation-strategies";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;
let individualId: string;
let historicalStrategyId: string;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
}

async function obligation(kind: string, ended = true, parentId?: string) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO settlement_obligations
       (source_key, kind, direction, individual_id, original_amount, period_begin, period_end, calculation_metadata, calculation_strategy_id)
     VALUES ($1, $2, 'reserve', $3, 100.1234, $4::date, $5::date, $6::jsonb, $7) RETURNING id`,
    [randomUUID(), kind, individualId, ended ? "2000-01-01" : "2999-01-01", ended ? "2000-12-31" : "2999-12-31",
      JSON.stringify({ flow: "individual_plan", ...(parentId ? { adjustmentForObligationId: parentId }
        : kind === "individual_masser" && ended ? { monthlyAmount: "100.1234", monthDivisor: "1" } : {}) }),
      kind === "individual_masser" && ended && !parentId ? historicalStrategyId : null],
  );
  return rows[0].id;
}

async function certifySyntheticSources() {
  // Only this disposable fixture: simulate the existing pre-upgrade certificate
  // without a successful new refresh, so persisted holds cannot mask the guard.
  await pool.query(`UPDATE settlement_ledger_state SET refreshed_version = source_version,
    refreshed_for_date = $1::date, dirty_since = NULL, blocked_obligation_ids = '{}', source_review_count = 0`,
  [settlementApplicationDate()]);
}

async function facts(table: "settlement_obligations" | "settlement_events") {
  return (await pool.query<{ id: string; fact: string }>(
    `SELECT id::text, to_jsonb(t)::text AS fact FROM ${table} t ORDER BY id`,
  )).rows;
}

suite("Legacy individual settlement source review (real PostgreSQL)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(`INSERT INTO users (id, email, display_name, password_hash, role)
      VALUES ($1, 'legacy-review@example.test', 'Synthetic Operator', 'x', 'admin')`, [ACTOR]);
    individualId = (await pool.query<{ id: string }>(`INSERT INTO individuals (normalized_name, display_name)
      VALUES ('synthetic legacy review', 'Synthetic Legacy Review') RETURNING id`)).rows[0].id;
    historicalStrategyId = (await pool.query<{ id: string }>(`INSERT INTO calculation_strategies
      (individual_id, label, status, after_all, month_divisor, renewal_date)
      VALUES ($1, 'Recorded historical single-month final', 'archived', 100.1234, 1, '2001-01-01') RETURNING id`,
    [individualId])).rows[0].id;
  });
  afterAll(closeTestPool);

  it.each([null, "not-a-real-obligation", "foreign-person", "self", "cycle"])(
    "holds an unsupported ended correction with unusable parent provenance: %s", async (parentShape) => {
      const orphan = await obligation("individual_masser_correction", true);
      let parentId = parentShape;
      if (parentShape === "self") parentId = orphan;
      if (parentShape === "cycle") parentId = await obligation("individual_masser_correction", true, orphan);
      if (parentShape === "foreign-person") {
        const other = (await pool.query<{ id: string }>(`INSERT INTO individuals (normalized_name, display_name)
          VALUES ('different synthetic parent', 'Different Synthetic Parent') RETURNING id`)).rows[0].id;
        parentId = await obligation("individual_masser");
        await pool.query(`UPDATE settlement_obligations SET individual_id = $2 WHERE id = $1`, [parentId, other]);
      }
      await pool.query(`UPDATE settlement_obligations SET calculation_metadata = jsonb_build_object(
        'flow', 'individual_plan', 'adjustmentForObligationId', $2::text) WHERE id = $1`, [orphan, parentId]);
      await certifySyntheticSources();
      const before = await facts("settlement_obligations");
      expect((await getSettlementDashboard(pool)).rows.find((row) => row.id === orphan)?.reviewRequired).toBe(true);
      expect(await recordObligationPayment(pool, { obligationId: orphan, amount: "1", occurredOn: settlementApplicationDate(), operationKey: randomUUID() }, ACTOR))
        .toMatchObject({ ok: false, message: expect.stringContaining("source review") });
      unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
      expect(await facts("settlement_obligations")).toEqual(before);
      expect((await getSettlementDashboard(pool)).rows.find((row) => row.id === orphan)?.reviewRequired).toBe(true);
      expect((await pool.query<{ ids: string[] }>(`SELECT blocked_obligation_ids AS ids FROM settlement_ledger_state`)).rows[0].ids)
        .toContain(orphan);
    },
  );

  it.each([true, false])("does not release an unsupported existing balance after setup one/zero/archive changes (ended=%s)", async (ended) => {
    const known = await obligation("individual_masser");
    const root = await obligation("individual_masser", ended);
    await pool.query(`UPDATE settlement_obligations SET calculation_strategy_id = $2, calculation_metadata =
      '{"flow":"individual_plan","formula":"fixed yearly set-aside","monthlyAmount":null}' WHERE id = $1`, [root, historicalStrategyId]);
    const child = await obligation("individual_masser_correction", true, root);
    const before = await facts("settlement_obligations");
    for (const change of [
      { divisor: "12", afterAll: "100.1234", status: "active" },
      { divisor: "1", afterAll: "100.1234", status: "active" },
      { divisor: "1", afterAll: "0", status: "archived" },
    ]) {
      await pool.query(`UPDATE calculation_strategies SET month_divisor = $2, after_all = $3, status = $4 WHERE id = $1`,
        [historicalStrategyId, change.divisor, change.afterAll, change.status]);
      await certifySyntheticSources();
      const dashboard = await getSettlementDashboard(pool);
      expect(dashboard.rows.find((row) => row.id === known)?.reviewRequired).toBe(false);
      expect(dashboard.rows.filter((row) => row.reviewRequired).map((row) => row.id).sort()).toEqual([root, child].sort());
      expect(dashboard.summary.reservesToSetAside).toBe("100.1234");
      expect(await recordObligationPayment(pool, { obligationId: child, amount: "1", occurredOn: settlementApplicationDate(), operationKey: randomUUID() }, ACTOR))
        .toMatchObject({ ok: false, message: expect.stringContaining("source review") });
      expect(await facts("settlement_obligations")).toEqual(before);
    }
    // With all current targets archived, refresh must preserve the supported
    // monthly historical row and hold the unsupported row and its descendant.
    for (let run = 0; run < 2; run++) {
      expect(unwrap(await refreshSettlementObligations(pool, {}, ACTOR))).toMatchObject({
        created: 0, updated: 0, adjusted: 0, voided: 0, amountBasisReviewCount: 2, preservedHistorical: 1,
      });
      expect(await facts("settlement_obligations")).toEqual(before);
    }
  });

  it("holds unknown monthly-versus-period basis without overwriting existing finals or creating converted balances", async () => {
    const renewalDate = `${Number(settlementApplicationDate().slice(0, 4)) + 1}-01-01`;
    const source = unwrap(await createStrategy(pool, { individualId }, ACTOR));
    unwrap(await updateStrategy(pool, { id: source.id, afterAll: "100.1234", monthDivisor: "12", renewalDate }, ACTOR));
    const missing = unwrap(await createStrategy(pool, { individualId, label: "No balance yet" }, ACTOR));
    unwrap(await updateStrategy(pool, { id: missing.id, afterAll: "70", monthDivisor: "12", renewalDate }, ACTOR));
    const explicitZero = unwrap(await createStrategy(pool, { individualId, label: "Approved zero" }, ACTOR));
    unwrap(await updateStrategy(pool, { id: explicitZero.id, afterAll: "0", monthDivisor: "12", renewalDate }, ACTOR));
    const periods = await listStrategies(pool);
    const current = periods.rows.find((row) => row.id === source.id)!;
    const currentKey = `v1:${createHash("sha256").update(JSON.stringify([
      "individual", source.id, current.periodStart, current.periodEnd, "individual_masser",
    ])).digest("hex").slice(0, 32)}`;
    const root = await obligation("individual_masser", false);
    await pool.query(`UPDATE settlement_obligations SET source_key = $2, calculation_strategy_id = $3,
      period_begin = $4::date, period_end = $5::date,
      calculation_metadata = '{"flow":"individual_plan","monthlyAmount":"100.1234","monthDivisor":"12"}'
      WHERE id = $1`, [root, currentKey, source.id, current.periodStart, current.periodEnd]);
    const child = await obligation("individual_masser_correction", true, root);
    const oldKey = await obligation("individual_masser", false);
    await pool.query(`UPDATE settlement_obligations SET calculation_strategy_id = $2 WHERE id = $1`, [oldKey, source.id]);
    await certifySyntheticSources();
    const paid = (await pool.query<{ id: string }>(`INSERT INTO settlement_events
      (settlement_obligation_id, individual_id, event_type, amount, occurred_on)
      VALUES ($1, $2, 'set_aside', 20, $3::date) RETURNING id`, [root, individualId, settlementApplicationDate()])).rows[0].id;
    const before = await facts("settlement_obligations");
    const cash = await facts("settlement_events");
    const priorSetup = (await pool.query(`SELECT to_jsonb(s)::text AS fact FROM calculation_strategies s ORDER BY id`)).rows;
    for (let run = 0; run < 2; run++) {
      const preRefresh = await getSettlementDashboard(pool);
      expect(preRefresh.rows.every((row) => row.reviewRequired)).toBe(true);
      expect(preRefresh.summary).toMatchObject({ reservesToSetAside: "0.0000", credits: "0.0000", appliedTotal: "20.0000" });
      expect(await recordObligationPayment(pool, { obligationId: child, amount: "1", occurredOn: settlementApplicationDate(), operationKey: randomUUID() }, ACTOR))
        .toMatchObject({ ok: false, message: expect.stringContaining("source review") });
      expect(await correctSettlementEvent(pool, paid, { amount: "15", occurredOn: settlementApplicationDate(), reason: "Synthetic correction", operationKey: randomUUID() }, ACTOR))
        .toMatchObject({ ok: false, message: expect.stringContaining("source review") });
      expect(unwrap(await refreshSettlementObligations(pool, {}, ACTOR))).toMatchObject({
        created: 0, updated: 0, adjusted: 0, voided: 0, amountBasisReviewCount: 4, reviewRequiredCount: 4,
      });
      expect(await facts("settlement_obligations")).toEqual(before);
      expect(await facts("settlement_events")).toEqual(cash);
      expect((await pool.query(`SELECT to_jsonb(s)::text AS fact FROM calculation_strategies s ORDER BY id`)).rows).toEqual(priorSetup);
      expect((await getSettlementDashboard(pool)).freshness.sourceReviewSummary).toContain("owner must confirm whether Financial Setup balances represent a month or the full period");
    }
  });

  it("preserves mixed synthetic legacy balances and explicitly supported historical monthly finals", async () => {
    // Synthetic values: 61 legacy explanation rows plus 19 deliberately
    // supported single-month historical finals. The separate private clone
    // proof covers the actual 80 unsupported production balances, all held.
    const legacyIds: string[] = [];
    for (const [kind, count] of [
      ["individual_cut_1", 20], ["individual_cut_2", 19],
      ["individual_clock", 19], ["individual_other", 3],
    ] as const) {
      for (let index = 0; index < count; index++) legacyIds.push(await obligation(kind, index % 2 === 0));
    }
    for (let index = 0; index < 19; index++) await obligation("individual_masser");
    await certifySyntheticSources();
    const before = await facts("settlement_obligations");
    expect(before).toHaveLength(80);
    const preRefresh = await getSettlementDashboard(pool);
    expect(preRefresh.rows.filter((row) => row.reviewRequired)).toHaveLength(61);
    expect(preRefresh.summary.reservesToSetAside).toBe("1902.3446");
    for (let run = 0; run < 2; run++) {
      expect(unwrap(await refreshSettlementObligations(pool, {}, ACTOR))).toMatchObject({
        created: 0, updated: 0, adjusted: 0, voided: 0, reviewRequiredCount: 61, preservedHistorical: 19,
      });
      expect(await facts("settlement_obligations")).toEqual(before);
      const dashboard = await getSettlementDashboard(pool);
      expect(dashboard.freshness).toMatchObject({ dirty: false, sourceReviewCount: 61 });
      expect(dashboard.freshness.sourceReviewSummary).toContain("Legacy individual cuts and give-back");
      expect(dashboard.rows.filter((row) => row.reviewRequired).map((row) => row.id).sort()).toEqual(legacyIds.sort());
      expect(dashboard.summary).toMatchObject({ reservesToSetAside: "1902.3446", employeesOwe: "0.0000", appliedTotal: "0.0000" });
      expect(await getSettlementSummary(pool)).toMatchObject(dashboard.summary);
      expect(await getPersonSettlementBalance(pool, { individualId })).toMatchObject({ reserve: "1902.3446", openItems: 19 });
      expect(await facts("settlement_events")).toEqual([]);
    }
    expect((await pool.query(`SELECT id FROM audit_logs WHERE action = 'settlements.refreshed'`)).rows).toHaveLength(2);
  });

  it.each(["individual_cut_1", "individual_cut_2", "individual_clock", "individual_other"])(
    "blocks all new money on %s and descendants before and after refresh, retaining prior cash and paired credits",
    async (kind) => {
      const root = await obligation(kind);
      // A differently named descendant cannot escape its unresolved root.
      const child = await obligation("individual_masser", true, root);
      const grandchild = await obligation("individual_masser_correction", true, child);
      const known = await obligation("individual_masser");
      await certifySyntheticSources();
      // These represent existing history created by a prior application, not
      // new money authorized through the reviewed application action path.
      const payment = (await pool.query<{ id: string }>(`INSERT INTO settlement_events
        (settlement_obligation_id, individual_id, event_type, amount, occurred_on)
        VALUES ($1, $2, 'set_aside', 120, '2000-06-01') RETURNING id`, [root, individualId])).rows[0].id;
      const batch = (await pool.query<{ id: string }>(`INSERT INTO settlement_batches
        (idempotency_key, action, created_by_user_id) VALUES ($1, 'apply_credit', $2) RETURNING id`,
      [randomUUID(), ACTOR])).rows[0].id;
      const credits = (await pool.query<{ id: string; settlement_obligation_id: string }>(`INSERT INTO settlement_events
        (settlement_obligation_id, settlement_batch_id, individual_id, event_type, amount, occurred_on)
        VALUES ($1, $3, $4, 'credit', -5, '2000-06-02'), ($2, $3, $4, 'credit', 5, '2000-06-02')
        RETURNING id, settlement_obligation_id`, [root, known, batch, individualId])).rows;
      const oldObligations = await facts("settlement_obligations");
      const oldCash = await facts("settlement_events");
      const occurredOn = settlementApplicationDate();
      for (let run = 0; run < 2; run++) {
        if (run === 1) {
          expect(unwrap(await refreshSettlementObligations(pool, {}, ACTOR))).toMatchObject({
            created: 0, updated: 0, adjusted: 0, voided: 0, reviewRequiredCount: 3,
          });
          const state = (await pool.query<{ ids: string[] }>(`SELECT blocked_obligation_ids AS ids FROM settlement_ledger_state`)).rows[0];
          expect(state.ids.sort()).toEqual([root, child, grandchild].sort());
        }
        const results = await Promise.all([
          ...[root, child, grandchild].map((obligationId) => recordObligationPayment(pool, {
            obligationId, amount: "1", occurredOn, operationKey: randomUUID(),
          }, ACTOR)),
          settleObligations(pool, { obligationIds: [known, child], occurredOn, operationKey: randomUUID() }, ACTOR),
          refundSettlementCredit(pool, { obligationId: root, amount: "1", occurredOn, operationKey: randomUUID() }, ACTOR),
          applySettlementCredit(pool, { sourceObligationId: root, targetObligationId: known, amount: "1", occurredOn, operationKey: randomUUID() }, ACTOR),
          applySettlementCredit(pool, { sourceObligationId: known, targetObligationId: child, amount: "1", occurredOn, operationKey: randomUUID() }, ACTOR),
          correctSettlementEvent(pool, payment, { amount: "110", occurredOn, reason: "Synthetic correction", operationKey: randomUUID() }, ACTOR),
          reverseSettlementEvent(pool, payment, "Synthetic reversal", ACTOR, randomUUID()),
          // Starting from the eligible peer must still inspect the held side.
          reverseSettlementEvent(pool, credits.find((row) => row.settlement_obligation_id === known)!.id,
            "Synthetic paired reversal", ACTOR, randomUUID()),
        ]);
        for (const result of results) expect(result).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("source review") });
        const dashboard = await getSettlementDashboard(pool);
        expect(dashboard.rows.filter((row) => row.reviewRequired).map((row) => row.id).sort()).toEqual([root, child, grandchild].sort());
        expect(dashboard.summary).toMatchObject({ reservesToSetAside: "95.1234", credits: "0.0000", appliedTotal: "120.0000" });
        expect(await facts("settlement_obligations")).toEqual(oldObligations);
        expect(await facts("settlement_events")).toEqual(oldCash);
      }
      unwrap(await recordObligationPayment(pool, { obligationId: known, amount: "1", occurredOn, operationKey: randomUUID() }, ACTOR));
    },
  );
});
