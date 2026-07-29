import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testPool, resetSchema, truncateBusinessTables, closeTestPool } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { createIndividual } from "@/lib/manage/individuals";
import { createEmployee } from "@/lib/manage/employees";
import { createAssignment } from "@/lib/manage/assignments";
import { createSession, detectConflicts } from "@/lib/manage/schedule";
import { saveCalculation, listCalculations, previewCalculation } from "@/lib/manage/calculations";
import { dec } from "@/lib/money";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

async function scalar<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await testPool().query<Record<string, T>>(sql, params);
  return Object.values(rows[0])[0];
}
const programId = (code: string) => scalar<string>(`SELECT id FROM programs WHERE code = $1`, [code]);
function unwrap<T>(r: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data;
}

suite("phase 4 — calculations + program-rule conflicts (real PostgreSQL)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(`INSERT INTO users (id, email, display_name, password_hash, role) VALUES ($1,$2,$3,'x','admin')`, [ACTOR, "a@a.test", "Admin"]);
  });
  afterAll(closeTestPool);

  it("saves a calculation with every step, then supersedes it on revision", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Calc Person" }, ACTOR));
    const dayHab = await programId("DAY_HAB");
    const first = unwrap(await saveCalculation(pool, {
      individualId: ind.id, programId: dayHab,
      annualAuthorizedHours: "1000", programRate: "17", agencyRate: "19",
      cut1Percent: "10", cut2Percent: "5", clockAdjustment: "0",
    }, ACTOR, "initial"));

    const row = await testPool().query<{ annual_gross: string; cut1_amount: string; after_all: string; agency_additional: string; status: string }>(
      `SELECT annual_gross::text, cut1_amount::text, after_all::text, agency_additional::text, status FROM budget_calculations WHERE id=$1`, [first.id]);
    expect(dec(row.rows[0].annual_gross).toNumber()).toBe(17000);
    expect(dec(row.rows[0].cut1_amount).toNumber()).toBe(1700);
    expect(dec(row.rows[0].after_all).toNumber()).toBe(14535); // 17000 -10% -5% seq
    expect(dec(row.rows[0].agency_additional).toNumber()).toBe(2000); // (19-17)*1000
    expect(row.rows[0].status).toBe("active");

    // Revise -> the old one is superseded, the new is active revision 2.
    unwrap(await saveCalculation(pool, {
      individualId: ind.id, programId: dayHab,
      annualAuthorizedHours: "1200", programRate: "17", cut1Percent: "10", cut2Percent: "5",
    }, ACTOR, "more hours"));
    const list = await listCalculations(pool, ind.id);
    expect(list.active).toHaveLength(1);
    expect(list.active[0].revision).toBe(2);
    expect(dec(list.active[0].annualGross!).toNumber()).toBe(20400); // 1200*17
    expect(list.history).toHaveLength(1);
    expect(list.history[0].status).toBe("superseded");
  });

  it("previewCalculation reproduces the sequential cuts without persisting", () => {
    const r = previewCalculation({ annualAuthorizedHours: "100", programRate: "20", cut1Percent: "10", cut2Percent: "50" });
    // 2000 -10% = 1800; -50% of 1800 = 900
    expect(dec(r.afterCut2).toNumber()).toBe(900);
  });

  it("flags a group on a one-to-one program, and a group over the configured maximum", async () => {
    const respite = await programId("RESPITE"); // one-to-one after 0005 backfill
    const dayHab = await programId("DAY_HAB");   // groups allowed
    const a = unwrap(await createIndividual(pool, { displayName: "P A" }, ACTOR));
    const b = unwrap(await createIndividual(pool, { displayName: "P B" }, ACTOR));
    const c = unwrap(await createIndividual(pool, { displayName: "P C" }, ACTOR));

    const respiteGroup = await detectConflicts(pool, {
      employeeId: null, programId: respite, individualIds: [a.id, b.id], sessionDate: "2025-03-10",
      startTime: null, endTime: null, durationHours: "2",
    });
    expect(respiteGroup.map((w) => w.code)).toContain("program_not_group");

    // Cap Day Hab at 2, then a group of 3 warns.
    await pool.query(`UPDATE programs SET max_group_size = 2 WHERE id = $1`, [dayHab]);
    const over = await detectConflicts(pool, {
      employeeId: null, programId: dayHab, individualIds: [a.id, b.id, c.id], sessionDate: "2025-03-10",
      startTime: null, endTime: null, durationHours: "2",
    });
    expect(over.map((w) => w.code)).toContain("group_over_max");
  });

  it("flags one individual booked with two different employees in a one-to-one program", async () => {
    const respite = await programId("RESPITE");
    const ind = unwrap(await createIndividual(pool, { displayName: "Shared Kid" }, ACTOR));
    const e1 = unwrap(await createEmployee(pool, { displayName: "Emp One" }, ACTOR));
    const e2 = unwrap(await createEmployee(pool, { displayName: "Emp Two" }, ACTOR));
    unwrap(await createAssignment(pool, { employeeId: e1.id, individualId: ind.id, programId: respite }, ACTOR));
    unwrap(await createAssignment(pool, { employeeId: e2.id, individualId: ind.id, programId: respite }, ACTOR));

    await createSession(pool, { employeeId: e1.id, programId: respite, individualIds: [ind.id], sessionDate: "2025-03-10", startTime: "09:00", endTime: "11:00", durationHours: "2" }, ACTOR);
    const second = await detectConflicts(pool, { employeeId: e2.id, programId: respite, individualIds: [ind.id], sessionDate: "2025-03-10", startTime: "10:00", endTime: "12:00", durationHours: "2" });
    expect(second.map((w) => w.code)).toContain("individual_two_employees_one_to_one");
  });

  it("stores the agency additional on a scheduled session (agency 19 vs internal 17 -> 2/h)", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Split Kid" }, ACTOR));
    const dayHab = await programId("DAY_HAB");
    const s = unwrap(await createSession(pool, { programId: dayHab, individualIds: [ind.id], sessionDate: "2025-03-10", durationHours: "10", employeeId: null, startTime: null, endTime: null }, ACTOR));
    const add = await scalar<string>(`SELECT expected_agency_additional::text FROM scheduled_sessions WHERE id=$1`, [s.id]);
    expect(dec(add).toNumber()).toBe(20); // (19-17) * 10
  });
});
