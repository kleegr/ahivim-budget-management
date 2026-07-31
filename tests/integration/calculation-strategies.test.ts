import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testPool, resetSchema, truncateBusinessTables, closeTestPool } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { createIndividual } from "@/lib/manage/individuals";
import {
  createStrategy,
  updateStrategy,
  duplicateStrategy,
  setStrategyStatus,
  listStrategies,
  listStrategyRevisions,
  explainStrategy,
} from "@/lib/manage/calculation-strategies";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

function unwrap<T>(r: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data;
}

/** Program + effective internal rate (seed reference data lives in migrations already). */
async function program(code: string, name: string, internalRate: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO programs (code, name) VALUES ($1,$2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [code, name],
  );
  const id = rows[0]!.id;
  await pool.query(
    `INSERT INTO program_rate_schedules (program_id, effective_from, internal_rate)
     VALUES ($1, '2020-01-01', $2)`,
    [id, internalRate],
  );
  return id;
}

suite("calculation strategies (real PostgreSQL)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(`DELETE FROM calculation_strategies`);
    await pool.query(`DELETE FROM program_rate_schedules`);
    await pool.query(`DELETE FROM programs`);
    await pool.query(`INSERT INTO users (id, email, display_name, password_hash, role) VALUES ($1,$2,$3,'x','admin')`, [ACTOR, "a@a.test", "Admin"]);
  });
  afterAll(closeTestPool);

  it("reproduces the workbook Joel Duestch numbers through the real service + rate schedules", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Joel Duestch" }, ACTOR));
    const comhab = await program("COMHAB", "Com Hab", "21");
    const shch = await program("SHCH", "Self Hired Com Hab", "38");
    const dayhab = await program("DAYHAB", "Day Hab", "17");
    const sdh = await program("SDH", "Supplemental Day Hab", "17");

    const strat = unwrap(await createStrategy(pool, { individualId: ind.id }, ACTOR));
    unwrap(
      await updateStrategy(
        pool,
        {
          id: strat.id,
          renewalDate: "2025-03-01",
          cut1Percent: "23", // 23%
          cut2Percent: "28",
          clockAdjustment: "-300",
          hours: { [comhab]: "780", [shch]: "860", [dayhab]: "1075", [sdh]: "430" },
        },
        ACTOR,
      ),
    );

    const { rows } = await listStrategies(pool, { individualId: ind.id });
    const row = rows[0]!;
    // 780×21 + 860×38 + 1075×17 + 430×17 = 74,645
    expect(Number(row.yearlyGross)).toBeCloseTo(74645, 2);
    expect(Number(row.monthlyGross)).toBeCloseTo(6220.4167, 2); // ÷12
    expect(Number(row.grossNet)).toBeCloseTo(3448.599, 1); // after 23% then 28%
    expect(Number(row.net)).toBeCloseTo(3148.599, 1); // − 300 clock
    // renewal-date-only: the 12-month period is derived
    expect(row.periodStart).toBe("2024-03-01");
    expect(row.periodEnd).toBe("2025-03-01");
  });

  it("keeps a non-destructive revision snapshot on every edit", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Test Person" }, ACTOR));
    const p = await program("COMHAB", "Com Hab", "21");
    const strat = unwrap(await createStrategy(pool, { individualId: ind.id }, ACTOR));
    unwrap(await updateStrategy(pool, { id: strat.id, hours: { [p]: "100" }, cut1Percent: "24" }, ACTOR, "first edit"));
    unwrap(await updateStrategy(pool, { id: strat.id, cut2Percent: "30" }, ACTOR, "second edit"));

    const revs = await listStrategyRevisions(pool, strat.id);
    expect(revs.length).toBe(2); // prior state snapshotted before each of the two edits
    expect(revs[0]!.reason).toBe("second edit");
    expect(revs[0]!.revision).toBe(2);
  });

  it("stores cut percentages as fractions and shows the step-by-step formula", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Fraction Test" }, ACTOR));
    const p = await program("DAYHAB", "Day Hab", "17");
    const strat = unwrap(await createStrategy(pool, { individualId: ind.id }, ACTOR));
    unwrap(await updateStrategy(pool, { id: strat.id, hours: { [p]: "1075" }, cut1Percent: "24", cut2Percent: "30" }, ACTOR));

    const stored = await pool.query<{ cut1_percent: string }>(`SELECT cut1_percent::text FROM calculation_strategies WHERE id = $1`, [strat.id]);
    expect(Number(stored.rows[0]!.cut1_percent)).toBeCloseTo(0.24, 4); // fraction, not 24

    const explain = await explainStrategy(pool, strat.id);
    expect(explain).not.toBeNull();
    expect(explain!.steps).toHaveLength(8);
    expect(Number(explain!.yearlyGross)).toBeCloseTo(18275, 2); // 1075 × 17
  });

  it("duplicates a strategy (copying its lines) without duplicating the individual", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Multi Strategy" }, ACTOR));
    const p = await program("COMHAB", "Com Hab", "21");
    const first = unwrap(await createStrategy(pool, { individualId: ind.id }, ACTOR));
    unwrap(await updateStrategy(pool, { id: first.id, hours: { [p]: "500" } }, ACTOR));
    unwrap(await duplicateStrategy(pool, { id: first.id, label: "2" }, ACTOR));

    const { rows } = await listStrategies(pool, { individualId: ind.id });
    expect(rows).toHaveLength(2); // two strategies…
    expect(new Set(rows.map((r) => r.individualId)).size).toBe(1); // …ONE canonical individual
    const individualsCount = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM individuals`);
    expect(Number(individualsCount.rows[0]!.c)).toBe(1); // no duplicate individual created
  });

  it("applies a per-strategy program rate override and recalculates immediately", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Rate Override Person" }, ACTOR));
    const p = await program("COMHAB", "Com Hab", "21"); // default rate 21
    const strat = unwrap(await createStrategy(pool, { individualId: ind.id }, ACTOR));
    unwrap(await updateStrategy(pool, { id: strat.id, hours: { [p]: "100" } }, ACTOR));

    // default: 100 × 21 = 2100
    let list = await listStrategies(pool, { individualId: ind.id });
    expect(Number(list.rows[0]!.yearlyGross)).toBeCloseTo(2100, 2);

    // override to 30 → 100 × 30 = 3000, recomputed on the very next read
    unwrap(await updateStrategy(pool, { id: strat.id, rateOverrides: { [p]: "30" } }, ACTOR));
    list = await listStrategies(pool, { individualId: ind.id });
    expect(Number(list.rows[0]!.yearlyGross)).toBeCloseTo(3000, 2);

    // the explain panel marks it as an override and remembers the default
    const explain = await explainStrategy(pool, strat.id);
    const line = explain!.lineGross[0]!;
    expect(line.isOverride).toBe(true);
    expect(Number(line.rate)).toBeCloseTo(30, 2);
    expect(Number(line.defaultRate)).toBeCloseTo(21, 2);

    // the change is in the strategy's revision history (non-destructive)
    const revs = await listStrategyRevisions(pool, strat.id);
    expect(revs.length).toBeGreaterThanOrEqual(2);

    // clearing reverts to the default
    unwrap(await updateStrategy(pool, { id: strat.id, rateOverrides: { [p]: null } }, ACTOR));
    list = await listStrategies(pool, { individualId: ind.id });
    expect(Number(list.rows[0]!.yearlyGross)).toBeCloseTo(2100, 2);
  });

  it("computes actual-vs-plan analytics from billed transactions", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Analytics Person" }, ACTOR));
    const p = await program("COMHAB", "Com Hab", "21");
    const strat = unwrap(await createStrategy(pool, { individualId: ind.id }, ACTOR));
    unwrap(await updateStrategy(pool, { id: strat.id, hours: { [p]: "1000" } }, ACTOR)); // plan 1000 hrs

    // 300 hours actually billed for this individual+program
    await pool.query(
      `INSERT INTO payroll_transactions (individual_id, program_id, imported_hours, calculated_internal_amount, transaction_fingerprint)
       VALUES ($1,$2,'300','6300','fp-an-1')`,
      [ind.id, p],
    );

    const { rows } = await listStrategies(pool, { individualId: ind.id, withAnalytics: true });
    const a = rows[0]!.analytics!;
    expect(Number(a.plannedHours)).toBeCloseTo(1000, 2);
    expect(Number(a.actualHours)).toBeCloseTo(300, 2);
    expect(Number(a.remainingHours)).toBeCloseTo(700, 2); // 1000 − 300 − 0 scheduled
    expect(Number(a.utilizationPercent)).toBeCloseTo(0.3, 3); // 300/1000
    expect(Number(a.actualInternal)).toBeCloseTo(6300, 2);
  });

  it("archives non-destructively (kept, not deleted) and hides from the active grid", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Archive Test" }, ACTOR));
    const strat = unwrap(await createStrategy(pool, { individualId: ind.id }, ACTOR));
    unwrap(await setStrategyStatus(pool, { id: strat.id, status: "archived" }, ACTOR));

    const active = await listStrategies(pool, { individualId: ind.id });
    expect(active.rows).toHaveLength(0); // hidden from active grid
    const all = await listStrategies(pool, { individualId: ind.id, includeArchived: true });
    expect(all.rows).toHaveLength(1); // still there — archived, not deleted
    expect(all.rows[0]!.status).toBe("archived");
  });
});
