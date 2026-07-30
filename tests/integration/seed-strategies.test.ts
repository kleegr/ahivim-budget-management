import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasTestDatabase, testPool, resetSchema, closeTestPool } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { listStrategies } from "@/lib/manage/calculation-strategies";

const suite = hasTestDatabase ? describe : describe.skip;
let pool: PgLikePool;

/**
 * Verifies migration 0007 seeds the workbook Calculations tab: every planning
 * row is representable, the "1"/"2" rows are strategies of ONE canonical
 * individual, and the seeded numbers reconcile to the workbook through the
 * live rate schedules.
 */
suite("seeded calculation strategies (migration 0007)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  afterAll(closeTestPool);

  it("seeds every workbook Calculation row (23 strategies, 21 individuals, no duplicates)", async () => {
    const { rows } = await listStrategies(pool, {});
    expect(rows).toHaveLength(23);
    const individuals = new Set(rows.map((r) => r.individualId));
    expect(individuals.size).toBe(21);
    const total = await pool.query<{ c: string }>(`SELECT count(*)::text c FROM individuals`);
    expect(Number(total.rows[0]!.c)).toBe(21); // exactly the canonical individuals, none duplicated
  });

  it("links the '1'/'2' rows to one canonical individual each", async () => {
    const { rows } = await listStrategies(pool, {});
    const byName = (name: string) => rows.filter((r) => r.individualName === name);
    const fradel = byName("Fradel Ostreicher");
    const mendel = byName("Mendel Stern");
    expect(fradel).toHaveLength(2);
    expect(mendel).toHaveLength(2);
    expect(new Set(fradel.map((r) => r.individualId)).size).toBe(1); // ONE individual, two strategies
    expect(new Set(mendel.map((r) => r.individualId)).size).toBe(1);
    expect(fradel.map((r) => r.label).sort()).toEqual(["1", "2"]);
  });

  it("reconciles seeded numbers to the workbook through the live rate schedules", async () => {
    const { rows } = await listStrategies(pool, {});
    const joel = rows.find((r) => r.individualName === "Joel Duestch")!;
    expect(Number(joel.yearlyGross)).toBeCloseTo(74645, 0); // 780×21 + 860×38 + 1075×17 + 430×17
    expect(Number(joel.net)).toBeCloseTo(3148.599, 0);
    expect(joel.renewalDate).toBe("2025-03-01");
    expect(joel.periodStart).toBe("2024-03-01"); // renewal − 12 months
  });
});
