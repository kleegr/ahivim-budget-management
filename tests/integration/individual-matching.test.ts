import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testPool, resetSchema, closeTestPool } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { createIndividual } from "@/lib/manage/individuals";
import { createStrategy } from "@/lib/manage/calculation-strategies";
import {
  mergeIndividuals,
  scanMatches,
  listMatchReviews,
  decideMatchReview,
  loadIndividualsForMatch,
} from "@/lib/manage/individual-merge";
import { scorePair } from "@/lib/business/individual-matching";
import { listStrategies, updateStrategy } from "@/lib/manage/calculation-strategies";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

function unwrap<T>(r: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data;
}

async function addTx(individualId: string, fp: string, amount = "100") {
  await pool.query(
    `INSERT INTO payroll_transactions (individual_id, imported_amount, transaction_fingerprint) VALUES ($1,$2,$3)`,
    [individualId, amount, fp],
  );
}

suite("individual matching + merge (real PostgreSQL)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(async () => {
    await pool.query(`DELETE FROM individual_match_reviews`);
    await pool.query(`DELETE FROM calculation_strategy_lines`);
    await pool.query(`DELETE FROM calculation_strategies`);
    await pool.query(`DELETE FROM payroll_transactions`);
    await pool.query(`DELETE FROM individual_aliases`);
    await pool.query(`UPDATE individuals SET merged_into_id = NULL`);
    await pool.query(`DELETE FROM individuals`);
    await pool.query(`INSERT INTO users (id, email, display_name, password_hash, role) VALUES ($1,$2,$3,'x','admin') ON CONFLICT (id) DO NOTHING`, [ACTOR, "a@a.test", "Admin"]);
  });
  afterAll(closeTestPool);

  it("scores a single-letter surname typo as an auto-merge and different first names as review-only", () => {
    // scorePair takes already-normalized (sorted-token) names, as loadIndividualsForMatch supplies.
    expect(scorePair("berl markovitz", "berl markowitz").kind).toBe("auto"); // Markovitz/Markowitz
    expect(scorePair("fleischman moshe", "fleishman moshe").kind).toBe("auto"); // Fleischman/Fleishman
    // A genuine full-name spelling variant → review (a human confirms).
    expect(scorePair("duestch joel", "deutsch joel").kind).toBe("review"); // Duestch/Deutsch ≈ 75%
    // Same surname but clearly different first name (siblings) → NOT flagged, no noise.
    expect(scorePair("neuwirth yaakov", "neuwirth yoel").kind).toBe("none");
    // Unrelated names → nothing.
    expect(scorePair("aaron levy", "klein miriam").kind).toBe("none");
  });

  it("auto-merges an obvious typo and repoints the strategy + transactions to the survivor", async () => {
    // The transaction spelling has the billing history (weight) → it survives.
    const billed = unwrap(await createIndividual(pool, { displayName: "Markovitz, Berl" }, ACTOR));
    await addTx(billed.id, "fp-1");
    await addTx(billed.id, "fp-2");
    const planned = unwrap(await createIndividual(pool, { displayName: "Berl Markowitz" }, ACTOR));
    unwrap(await createStrategy(pool, { individualId: planned.id, label: "1" }, ACTOR));

    const result = unwrap(await scanMatches(pool, ACTOR));
    expect(result.merged).toBe(1);
    expect(result.queued).toBe(0);

    // Exactly one active individual remains…
    const active = await loadIndividualsForMatch(pool);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(billed.id); // the billed row survived
    // …the strategy moved to the survivor…
    const strat = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM calculation_strategies WHERE individual_id = $1`, [billed.id]);
    expect(Number(strat.rows[0]!.c)).toBe(1);
    // …the folded row is archived + points at the survivor…
    const folded = await pool.query<{ status: string; merged_into_id: string | null }>(`SELECT status, merged_into_id FROM individuals WHERE id = $1`, [planned.id]);
    expect(folded.rows[0]!.status).toBe("archived");
    expect(folded.rows[0]!.merged_into_id).toBe(billed.id);
    // …an approved alias captures the old spelling…
    const alias = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM individual_aliases WHERE individual_id = $1 AND status = 'approved'`, [billed.id]);
    expect(Number(alias.rows[0]!.c)).toBe(1);
    // …and NO transaction was lost.
    const tx = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM payroll_transactions WHERE individual_id = $1`, [billed.id]);
    expect(Number(tx.rows[0]!.c)).toBe(2);
  });

  it("queues an uncertain pair for review instead of guessing, then confirms it", async () => {
    const billed = unwrap(await createIndividual(pool, { displayName: "Deutsch, Joel" }, ACTOR));
    await addTx(billed.id, "fp-d1");
    const planned = unwrap(await createIndividual(pool, { displayName: "Joel Duestch" }, ACTOR));
    unwrap(await createStrategy(pool, { individualId: planned.id, label: "1" }, ACTOR));

    const scan = unwrap(await scanMatches(pool, ACTOR));
    expect(scan.merged).toBe(0); // NOT auto-merged
    expect(scan.queued).toBe(1);

    const reviews = await listMatchReviews(pool, { status: "pending" });
    expect(reviews).toHaveLength(1);
    const r = reviews[0]!;
    expect([r.keepName, r.mergeName].sort()).toEqual(["Deutsch, Joel", "Joel Duestch"]);
    expect(r.reason).toBeTruthy(); // a human-readable "why"

    unwrap(await decideMatchReview(pool, { id: r.id, decision: "confirm" }, ACTOR));
    const active = await loadIndividualsForMatch(pool);
    expect(active).toHaveLength(1); // now merged
  });

  it("remembers a rejected pair and does not re-suggest it", async () => {
    const a = unwrap(await createIndividual(pool, { displayName: "Deutsch, Joel" }, ACTOR));
    await addTx(a.id, "fp-r1");
    unwrap(await createIndividual(pool, { displayName: "Joel Duestch" }, ACTOR));

    unwrap(await scanMatches(pool, ACTOR));
    const [review] = await listMatchReviews(pool, { status: "pending" });
    unwrap(await decideMatchReview(pool, { id: review!.id, decision: "reject" }, ACTOR));

    const second = unwrap(await scanMatches(pool, ACTOR));
    expect(second.queued).toBe(0); // rejected pair not re-queued
    expect(await listMatchReviews(pool, { status: "pending" })).toHaveLength(0);
    expect(await loadIndividualsForMatch(pool)).toHaveLength(2); // both kept as distinct people
  });

  it("connects billing to the strategy through a merge: actuals follow the canonical individual", async () => {
    // Program with a default rate.
    const { rows: pr } = await pool.query<{ id: string }>(
      `INSERT INTO programs (code, name) VALUES ('COMHAB','Com Hab') RETURNING id`,
    );
    const program = pr[0]!.id;
    await pool.query(`INSERT INTO program_rate_schedules (program_id, effective_from, internal_rate) VALUES ($1,'2020-01-01','21')`, [program]);

    // The billed spelling has 100 hours billed; the planning spelling has the strategy (200 planned).
    const billed = unwrap(await createIndividual(pool, { displayName: "Deutsch, Joel" }, ACTOR));
    await pool.query(
      `INSERT INTO payroll_transactions (individual_id, program_id, imported_hours, calculated_internal_amount, transaction_fingerprint)
       VALUES ($1,$2,'100','2100','fp-conn-1')`,
      [billed.id, program],
    );
    const planned = unwrap(await createIndividual(pool, { displayName: "Joel Duestch" }, ACTOR));
    const strat = unwrap(await createStrategy(pool, { individualId: planned.id, label: "1" }, ACTOR));
    unwrap(await updateStrategy(pool, { id: strat.id, hours: { [program]: "200" } }, ACTOR));

    // Before merge: the planning strategy sees NO actuals (different individual row).
    const list = await listStrategies(pool, { individualId: planned.id, withAnalytics: true });
    expect(Number(list.rows[0]!.analytics!.actualHours)).toBe(0);

    // Scan queues the uncertain pair; confirm it → merge (the billed row survives, being heavier).
    unwrap(await scanMatches(pool, ACTOR));
    const [review] = await listMatchReviews(pool, { status: "pending" });
    expect(review).toBeTruthy();
    unwrap(await decideMatchReview(pool, { id: review!.id, decision: "confirm" }, ACTOR));

    // After merge: exactly one individual, and its strategy now sees the billed 100 hours as actuals.
    const active = await loadIndividualsForMatch(pool);
    expect(active).toHaveLength(1);
    const merged = await listStrategies(pool, { individualId: active[0]!.id, withAnalytics: true });
    expect(merged.rows).toHaveLength(1); // the strategy followed the person
    const a = merged.rows[0]!.analytics!;
    expect(Number(a.plannedHours)).toBeCloseTo(200, 2);
    expect(Number(a.actualHours)).toBeCloseTo(100, 2); // canonical individual's real billing
    expect(Number(a.remainingHours)).toBeCloseTo(100, 2);
  });

  it("a direct merge repoints EVERY individual_id child table (nothing orphaned)", async () => {
    const keep = unwrap(await createIndividual(pool, { displayName: "Keep Person" }, ACTOR));
    const gone = unwrap(await createIndividual(pool, { displayName: "Gone Person" }, ACTOR));
    await addTx(gone.id, "fp-m1");
    unwrap(await createStrategy(pool, { individualId: gone.id, label: "1" }, ACTOR));
    // a budget period on the folded individual
    await pool.query(`INSERT INTO budget_periods (individual_id, label, start_date, end_date) VALUES ($1, 'P1', '2024-01-01', '2025-01-01')`, [gone.id]);

    const res = unwrap(await mergeIndividuals(pool, { keepId: keep.id, mergeId: gone.id }, ACTOR));
    expect(res.repointed.payroll_transactions).toBe(1);
    expect(res.repointed.calculation_strategies).toBe(1);
    expect(res.repointed.budget_periods).toBe(1);

    // Nothing still references the folded row.
    for (const table of ["payroll_transactions", "calculation_strategies", "budget_periods"]) {
      const left = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM ${table} WHERE individual_id = $1`, [gone.id]);
      expect(Number(left.rows[0]!.c)).toBe(0);
    }
  });
});
