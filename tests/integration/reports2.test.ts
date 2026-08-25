import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  hasTestDatabase,
  testPool,
  resetSchema,
  truncateBusinessTables,
  closeTestPool,
} from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { createIndividual } from "@/lib/manage/individuals";
import { createSession } from "@/lib/manage/schedule";
import { saveCalculation } from "@/lib/manage/calculations";
import { cutsMonthlyReport, actualVsScheduledReport } from "@/lib/data/report-queries";
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

suite("phase 4D — additional reports (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role) VALUES ($1,$2,$3,'x','admin')`,
      [ACTOR, "a@a.test", "Admin"],
    );
  });
  afterAll(closeTestPool);

  it("cuts-monthly returns a saved calculation's After All and the spreadsheet difference", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Cuts Person" }, ACTOR));
    const dayHab = await programId("DAY_HAB");

    // 1000 h x 17 = 17000 gross; -10% then -5% sequentially -> 14535 After All.
    unwrap(
      await saveCalculation(
        pool,
        {
          individualId: ind.id,
          programId: dayHab,
          annualAuthorizedHours: "1000",
          programRate: "17",
          agencyRate: "19",
          cut1Percent: "10",
          cut2Percent: "5",
          clockAdjustment: "0",
          spreadsheetValue: "15000",
        },
        ACTOR,
        "initial",
      ),
    );

    const rows = await cutsMonthlyReport(pool, {});
    const row = rows.find((r) => r.individualName === "Cuts Person");
    expect(row).toBeTruthy();
    expect(dec(row!.annualGross!).toNumber()).toBe(17000);
    expect(dec(row!.afterAll!).toNumber()).toBe(14535);
    expect(dec(row!.spreadsheetValue!).toNumber()).toBe(15000);
    // difference = spreadsheet value - system After All.
    expect(dec(row!.difference!).toNumber()).toBe(465);
  });

  it("actual-vs-scheduled computes the variance (actual minus scheduled) for hours and money", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Variance Kid" }, ACTOR));
    const dayHab = await programId("DAY_HAB");

    // Scheduled side: one pending 10 h session -> 10 scheduled hours and 170
    // expected internal (10 h x the DAY_HAB internal rate of 17).
    unwrap(
      await createSession(
        pool,
        {
          programId: dayHab,
          individualIds: [ind.id],
          sessionDate: "2025-03-10",
          durationHours: "10",
          employeeId: null,
          startTime: null,
          endTime: null,
        },
        ACTOR,
        "authorization setup omitted for variance fixture",
      ),
    );

    // Actual side: an imported transaction and the service session/allocation it
    // produced. Actual = 7 h and 119 internal (7 h x 17).
    const tx = await testPool().query<{ id: string }>(
      `INSERT INTO payroll_transactions
         (individual_id, program_id, period_begin, period_end, imported_hours,
          calculated_internal_amount, transaction_fingerprint)
       VALUES ($1,$2,'2025-03-01','2025-03-15','7','119','avs-fp-1') RETURNING id`,
      [ind.id, dayHab],
    );
    const session = await testPool().query<{ id: string }>(
      `INSERT INTO service_sessions (program_id, physical_hours, group_size)
       VALUES ($1,'7',1) RETURNING id`,
      [dayHab],
    );
    await testPool().query(
      `INSERT INTO service_allocations
         (service_session_id, individual_id, payroll_transaction_id,
          allocation_hours, allocated_rate, allocated_amount)
       VALUES ($1,$2,$3,'7','17','119')`,
      [session.rows[0].id, ind.id, tx.rows[0].id],
    );

    const rows = await actualVsScheduledReport(pool, {});
    const row = rows.find((r) => r.individualName === "Variance Kid");
    expect(row).toBeTruthy();
    expect(dec(row!.scheduledHours).toNumber()).toBe(10);
    expect(dec(row!.scheduledInternal).toNumber()).toBe(170);
    expect(dec(row!.actualHours).toNumber()).toBe(7);
    expect(dec(row!.actualInternal).toNumber()).toBe(119);
    // Variance is actual - scheduled: 7 - 10 = -3 hours; 119 - 170 = -51 dollars.
    expect(dec(row!.hoursVariance).toNumber()).toBe(-3);
    expect(dec(row!.internalVariance).toNumber()).toBe(-51);
  });
});
