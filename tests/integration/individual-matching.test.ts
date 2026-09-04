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
import {
  createClassBudget,
  createClassInvoiceDraft,
  issueClassInvoice,
} from "@/lib/manage/class-invoices";
import {
  createClassCoverSheetSnapshot,
  saveClassReimbursementProfile,
} from "@/lib/manage/class-reimbursement-profiles";

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
    await pool.query(`TRUNCATE class_budget_periods, class_reimbursement_profiles, program_budget_events CASCADE`);
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

  it("queues even a single-letter surname typo and ignores clearly different people", () => {
    // scorePair takes already-normalized (sorted-token) names, as loadIndividualsForMatch supplies.
    expect(scorePair("berl markovitz", "berl markowitz").kind).toBe("review"); // Markovitz/Markowitz
    expect(scorePair("fleischman moshe", "fleishman moshe").kind).toBe("review"); // Fleischman/Fleishman
    // A genuine full-name spelling variant → review (a human confirms).
    expect(scorePair("duestch joel", "deutsch joel").kind).toBe("review"); // Duestch/Deutsch ≈ 75%
    // Same surname but clearly different first name (siblings) → NOT flagged, no noise.
    expect(scorePair("neuwirth yaakov", "neuwirth yoel").kind).toBe("none");
    // Unrelated names → nothing.
    expect(scorePair("aaron levy", "klein miriam").kind).toBe("none");
  });

  it("queues an obvious typo without changing either person, then merges only after confirmation", async () => {
    // The transaction spelling has the billing history (weight) → it survives.
    const billed = unwrap(await createIndividual(pool, { displayName: "Markovitz, Berl" }, ACTOR));
    await addTx(billed.id, "fp-1");
    await addTx(billed.id, "fp-2");
    const planned = unwrap(await createIndividual(pool, { displayName: "Berl Markowitz" }, ACTOR));
    unwrap(await createStrategy(pool, { individualId: planned.id, label: "1" }, ACTOR));

    const result = unwrap(await scanMatches(pool, ACTOR));
    expect(result.merged).toBe(0);
    expect(result.queued).toBe(1);

    // Scanning alone is read-only with respect to both people and their records.
    const active = await loadIndividualsForMatch(pool);
    expect(active).toHaveLength(2);
    const strat = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM calculation_strategies WHERE individual_id = $1`, [billed.id]);
    expect(Number(strat.rows[0]!.c)).toBe(0);
    const folded = await pool.query<{ status: string; merged_into_id: string | null }>(`SELECT status, merged_into_id FROM individuals WHERE id = $1`, [planned.id]);
    expect(folded.rows[0]!.status).toBe("active");
    expect(folded.rows[0]!.merged_into_id).toBeNull();
    const alias = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM individual_aliases WHERE individual_id = $1 AND status = 'approved'`, [billed.id]);
    expect(Number(alias.rows[0]!.c)).toBe(0);
    const tx = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM payroll_transactions WHERE individual_id = $1`, [billed.id]);
    expect(Number(tx.rows[0]!.c)).toBe(2);

    // A human decision is the only operation that performs the merge.
    const [review] = await listMatchReviews(pool, { status: "pending" });
    expect(review).toBeTruthy();
    unwrap(await decideMatchReview(pool, { id: review!.id, decision: "confirm" }, ACTOR));
    const after = await loadIndividualsForMatch(pool);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(billed.id);
    const movedStrategy = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM calculation_strategies WHERE individual_id = $1`, [billed.id]);
    expect(Number(movedStrategy.rows[0]!.c)).toBe(1);
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
      `INSERT INTO payroll_transactions
         (individual_id, program_id, period_begin, imported_hours,
          calculated_internal_amount, transaction_fingerprint)
       VALUES ($1,$2,'2026-01-01','100','2100','fp-conn-1')`,
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
    const homeAgency = await pool.query<{ id: string }>(`SELECT id FROM agencies WHERE is_home_agency = true`);
    await pool.query(
      `INSERT INTO agency_individuals
       (agency_id, individual_id, manages_budget, bills_services, effective_from)
       VALUES ($1, $2, true, false, '2025-01-01')`,
      [homeAgency.rows[0]!.id, keep.id],
    );
    await pool.query(
      `INSERT INTO agency_individuals
         (agency_id, individual_id, manages_budget, bills_services, effective_from, effective_to)
       VALUES ($1, $2, false, true, '2024-01-01', '2024-12-31')`,
      [homeAgency.rows[0]!.id, gone.id],
    );
    await pool.query(
      `INSERT INTO user_individual_access (user_id, individual_id)
       VALUES ($1, $2), ($1, $3)`,
      [ACTOR, keep.id, gone.id],
    );
    await pool.query(
      `INSERT INTO user_individual_relationships
         (user_id, individual_id, relationship_type, capability_grants, capability_denials)
       VALUES ($1, $2, 'parent', ARRAY['hours_budgets.direct.read'], ARRAY[]::text[]),
              ($1, $3, 'parent', ARRAY['dollar_budgets.direct.read'], ARRAY['financials.direct.billed_totals.read'])`,
      [ACTOR, keep.id, gone.id],
    );

    const res = unwrap(await mergeIndividuals(pool, { keepId: keep.id, mergeId: gone.id }, ACTOR));
    expect(res.repointed.payroll_transactions).toBe(1);
    expect(res.repointed.calculation_strategies).toBe(1);
    expect(res.repointed.budget_periods).toBe(1);
    expect(res.repointed.agency_individuals).toBe(1);

    const agencyMembership = await pool.query<{
      manages_budget: boolean;
      bills_services: boolean;
      effective_from: string;
      effective_to: string | null;
    }>(
      `SELECT manages_budget, bills_services, effective_from::text, effective_to::text
         FROM agency_individuals WHERE agency_id = $1 AND individual_id = $2
        ORDER BY effective_from`,
      [homeAgency.rows[0]!.id, keep.id],
    );
    expect(agencyMembership.rows).toEqual([
      {
        manages_budget: false,
        bills_services: true,
        effective_from: "2024-01-01",
        effective_to: "2024-12-31",
      },
      {
        manages_budget: true,
        bills_services: false,
        effective_from: "2025-01-01",
        effective_to: null,
      },
    ]);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM user_individual_access WHERE user_id = $1 AND individual_id = $2`,
      [ACTOR, keep.id],
    )).rows[0]?.count).toBe("1");
    const portalRelationship = await pool.query<{ grants: string[]; denials: string[] }>(
      `SELECT capability_grants AS grants, capability_denials AS denials
         FROM user_individual_relationships
        WHERE user_id = $1 AND individual_id = $2 AND relationship_type = 'parent'`,
      [ACTOR, keep.id],
    );
    expect(portalRelationship.rows[0]?.grants).toEqual([
      "dollar_budgets.direct.read",
      "hours_budgets.direct.read",
    ]);
    expect(portalRelationship.rows[0]?.denials).toEqual(["financials.direct.billed_totals.read"]);

    // Nothing still references the folded row.
    for (const table of ["payroll_transactions", "calculation_strategies", "budget_periods"]) {
      const left = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM ${table} WHERE individual_id = $1`, [gone.id]);
      expect(Number(left.rows[0]!.c)).toBe(0);
    }
  });

  it("preserves issued class billing, its ledger, profile, and frozen cover sheet through a merge", async () => {
    const keep = unwrap(await createIndividual(pool, { displayName: "Canonical Class Person" }, ACTOR));
    const duplicate = unwrap(await createIndividual(pool, { displayName: "Duplicate Class Person" }, ACTOR));
    const budget = unwrap(await createClassBudget(pool, {
      individualId: duplicate.id,
      label: "2026 classes",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      authorizedAmount: "20000",
    }, ACTOR));
    const activity = await pool.query<{ id: string }>(
      `SELECT id FROM class_activities WHERE code = 'ART'`,
    );
    const draft = unwrap(await createClassInvoiceDraft(pool, {
      classBudgetPeriodId: budget.id,
      invoiceNumber: "MERGE-CLASS-1",
      invoiceDate: "2026-08-02",
      servicePeriodStart: "2026-07-01",
      servicePeriodEnd: "2026-07-31",
      lines: [{ activityId: activity.rows[0]!.id, serviceDate: "2026-07-01" }],
    }, ACTOR));
    const issued = unwrap(await issueClassInvoice(pool, draft.id, ACTOR));
    const profile = unwrap(await saveClassReimbursementProfile(pool, duplicate.id, {
      mailingName: "Canonical Class Person",
      medicaidId: "MERGE-SNAPSHOT-ID",
      lifePlanConfirmed: true,
    }, ACTOR));
    unwrap(await createClassCoverSheetSnapshot(pool, issued.id, profile, ACTOR));

    const result = unwrap(await mergeIndividuals(pool, {
      keepId: keep.id,
      mergeId: duplicate.id,
    }, ACTOR, "Confirmed duplicate"));
    expect(result.repointed).toMatchObject({
      class_budget_periods: 1,
      class_invoices: 1,
      class_reimbursement_profiles: 1,
    });
    expect((await pool.query<{ individual_id: string; status: string }>(
      `SELECT individual_id, status FROM class_invoices WHERE id = $1`,
      [issued.id],
    )).rows[0]).toEqual({ individual_id: keep.id, status: "issued" });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM class_budget_ledger WHERE class_invoice_id = $1`,
      [issued.id],
    )).rows[0]?.count).toBe("1");
    expect((await pool.query<{ individual_id: string }>(
      `SELECT individual_id FROM class_reimbursement_profiles WHERE individual_id = $1`,
      [keep.id],
    )).rows[0]?.individual_id).toBe(keep.id);
    expect((await pool.query<{ snapshot: { medicaidId?: string } }>(
      `SELECT profile_snapshot AS snapshot FROM class_cover_sheet_snapshots WHERE class_invoice_id = $1`,
      [issued.id],
    )).rows[0]?.snapshot.medicaidId).toBe("MERGE-SNAPSHOT-ID");
  });

  it("blocks a merge when reimbursement profiles disagree", async () => {
    const keep = unwrap(await createIndividual(pool, { displayName: "Profile One" }, ACTOR));
    const duplicate = unwrap(await createIndividual(pool, { displayName: "Profile Two" }, ACTOR));
    unwrap(await saveClassReimbursementProfile(pool, keep.id, {
      medicaidId: "PROFILE-A",
      lifePlanConfirmed: true,
    }, ACTOR));
    unwrap(await saveClassReimbursementProfile(pool, duplicate.id, {
      medicaidId: "PROFILE-B",
      lifePlanConfirmed: true,
    }, ACTOR));

    await expect(mergeIndividuals(pool, { keepId: keep.id, mergeId: duplicate.id }, ACTOR))
      .resolves.toMatchObject({ ok: false, code: "conflict" });
    expect(await loadIndividualsForMatch(pool)).toHaveLength(2);
  });

  it("blocks a merge that would create overlapping active program authorizations", async () => {
    const keep = unwrap(await createIndividual(pool, { displayName: "Program Keep" }, ACTOR));
    const duplicate = unwrap(await createIndividual(pool, { displayName: "Program Duplicate" }, ACTOR));
    const program = await pool.query<{ id: string }>(`SELECT id FROM programs WHERE code = 'COM_HAB'`);
    const periods = await pool.query<{ id: string; individual_id: string }>(
      `INSERT INTO budget_periods (individual_id, label, start_date, end_date, status)
       VALUES ($1, 'Keep period', '2026-01-01', '2026-12-31', 'active'),
              ($2, 'Duplicate period', '2026-06-01', '2027-05-31', 'active')
       RETURNING id, individual_id`,
      [keep.id, duplicate.id],
    );
    const keepPeriod = periods.rows.find((row) => row.individual_id === keep.id)!;
    const duplicatePeriod = periods.rows.find((row) => row.individual_id === duplicate.id)!;
    await pool.query(
      `INSERT INTO budget_authorizations
         (budget_period_id, individual_id, program_id, authorized_hours, internal_rate, status)
       VALUES ($1, $2, $5, 100, 21, 'active'), ($3, $4, $5, 100, 21, 'active')`,
      [keepPeriod.id, keep.id, duplicatePeriod.id, duplicate.id, program.rows[0]!.id],
    );

    await expect(mergeIndividuals(pool, { keepId: keep.id, mergeId: duplicate.id }, ACTOR))
      .resolves.toMatchObject({ ok: false, code: "conflict" });
    expect(await loadIndividualsForMatch(pool)).toHaveLength(2);
  });
});
