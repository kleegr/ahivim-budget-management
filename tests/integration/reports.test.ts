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
import { createEmployee } from "@/lib/manage/employees";
import { createBudgetPeriod, createAuthorization } from "@/lib/manage/authorizations";
import {
  agencyEarningsReport,
  budgetUtilizationReport,
  employeePayableReport,
} from "@/lib/data/report-queries";
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

let fpSeq = 0;

/** Insert a committed payroll transaction with the four money columns explicit. */
async function insertTransaction(opts: {
  individualId: string;
  employeeId?: string;
  programId: string;
  periodBegin?: string;
  periodEnd?: string;
  checkNumber?: string;
  hours?: string;
  agencyGross?: string;
  internalAmount?: string;
  agencyAdditional?: string;
  employeePayment?: string;
  paymentRecipient?: string | null;
}): Promise<string> {
  const { rows } = await testPool().query<{ id: string }>(
    `INSERT INTO payroll_transactions
       (individual_id, employee_id, program_id, period_begin, period_end, check_number,
        imported_hours, imported_amount, calculated_internal_amount,
        agency_additional_amount, employee_payment_amount, payment_recipient,
        transaction_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      opts.individualId,
      opts.employeeId ?? null,
      opts.programId,
      opts.periodBegin ?? "2025-03-01",
      opts.periodEnd ?? "2025-03-15",
      opts.checkNumber ?? null,
      opts.hours ?? null,
      opts.agencyGross ?? null,
      opts.internalAmount ?? null,
      opts.agencyAdditional ?? null,
      opts.employeePayment ?? null,
      opts.paymentRecipient === undefined ? null : opts.paymentRecipient,
      `rep-fp-${fpSeq++}`,
    ],
  );
  return rows[0].id;
}

/** Record actual used hours: a service session with one allocation to the individual. */
async function insertUsage(opts: {
  individualId: string;
  programId: string;
  hours: string;
  amount: string;
}): Promise<void> {
  const session = await testPool().query<{ id: string }>(
    `INSERT INTO service_sessions (program_id, physical_hours, group_size)
     VALUES ($1,$2,1) RETURNING id`,
    [opts.programId, opts.hours],
  );
  await testPool().query(
    `INSERT INTO service_allocations
       (service_session_id, individual_id, allocation_hours, allocated_rate, allocated_amount)
     VALUES ($1,$2,$3,$4,$5)`,
    [session.rows[0].id, opts.individualId, opts.hours, "17", opts.amount],
  );
}

suite("phase 4D — reporting read models (real PostgreSQL)", () => {
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
    fpSeq = 0;
  });
  afterAll(closeTestPool);

  it("agencyEarningsReport keeps agency / internal / additional separate and sums per program", async () => {
    const dayHab = await programId("DAY_HAB");
    const respite = await programId("RESPITE");
    const ind = unwrap(await createIndividual(pool, { displayName: "Aaron Levy" }, ACTOR));

    // Two Day Hab rows and one Respite row. Additional is exactly gross - internal.
    await insertTransaction({ individualId: ind.id, programId: dayHab, agencyGross: "190", internalAmount: "170", agencyAdditional: "20" });
    await insertTransaction({ individualId: ind.id, programId: dayHab, agencyGross: "95", internalAmount: "85", agencyAdditional: "10" });
    await insertTransaction({ individualId: ind.id, programId: respite, agencyGross: "57", internalAmount: "51", agencyAdditional: "6" });

    const rows = await agencyEarningsReport(pool, {});
    const byProgram = new Map(rows.map((r) => [r.programCode, r]));

    const day = byProgram.get("DAY_HAB")!;
    expect(day.transactionCount).toBe(2);
    // Three distinct columns, each summed on its own — never collapsed.
    expect(dec(day.agencyGross).toNumber()).toBe(285);
    expect(dec(day.internalAmount).toNumber()).toBe(255);
    expect(dec(day.agencyAdditional).toNumber()).toBe(30);
    // The business identity holds: agency additional = agency gross - internal.
    expect(dec(day.agencyAdditional).toNumber()).toBe(
      dec(day.agencyGross).minus(dec(day.internalAmount)).toNumber(),
    );

    const resp = byProgram.get("RESPITE")!;
    expect(dec(resp.agencyGross).toNumber()).toBe(57);
    expect(dec(resp.internalAmount).toNumber()).toBe(51);
    expect(dec(resp.agencyAdditional).toNumber()).toBe(6);

    // The date filter narrows the set without merging the columns.
    await insertTransaction({ individualId: ind.id, programId: dayHab, periodBegin: "2026-01-05", periodEnd: "2026-01-19", agencyGross: "1000", internalAmount: "900", agencyAdditional: "100" });
    const jan = await agencyEarningsReport(pool, { from: "2026-01-01", to: "2026-01-31" });
    const janDay = jan.find((r) => r.programCode === "DAY_HAB")!;
    expect(dec(janDay.agencyGross).toNumber()).toBe(1000);
    expect(dec(janDay.agencyAdditional).toNumber()).toBe(100);
  });

  it("budgetUtilizationReport computes %used and %committed correctly", async () => {
    const dayHab = await programId("DAY_HAB");
    const ind = unwrap(await createIndividual(pool, { displayName: "Bina Stern" }, ACTOR));
    const period = unwrap(
      await createBudgetPeriod(
        pool,
        { individualId: ind.id, label: "FY25", startDate: "2025-01-01", endDate: "2025-12-31" },
        ACTOR,
      ),
    );
    unwrap(
      await createAuthorization(
        pool,
        { budgetPeriodId: period.id, programId: dayHab, authorizedHours: "100", internalRate: "17" },
        ACTOR,
      ),
    );

    // 25 actual hours used out of 100 authorized -> 25%.
    await insertUsage({ individualId: ind.id, programId: dayHab, hours: "25", amount: "425" });

    const rows = await budgetUtilizationReport(pool, {});
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(dec(row.authorizedHours).toNumber()).toBe(100);
    expect(dec(row.usedHours).toNumber()).toBe(25);
    expect(dec(row.remainingHours).toNumber()).toBe(75);
    expect(row.percentUsed).not.toBeNull();
    expect(dec(row.percentUsed!).toNumber()).toBe(25);
    // No schedule yet, so committed equals used.
    expect(dec(row.percentCommitted!).toNumber()).toBe(25);

    // A pending scheduled session adds 15 committed hours -> 40% committed, 25% used.
    const session = await pool.query<{ id: string }>(
      `INSERT INTO scheduled_sessions (program_id, session_date, duration_hours, status)
       VALUES ($1,'2025-06-01','15','pending') RETURNING id`,
      [dayHab],
    );
    await pool.query(
      `INSERT INTO scheduled_allocations (scheduled_session_id, individual_id, allocation_hours)
       VALUES ($1,$2,'15')`,
      [session.rows[0].id, ind.id],
    );

    const after = await budgetUtilizationReport(pool, {});
    expect(dec(after[0].percentUsed!).toNumber()).toBe(25);
    expect(dec(after[0].percentCommitted!).toNumber()).toBe(40);
    expect(dec(after[0].scheduledHours).toNumber()).toBe(15);
  });

  it("employeePayableReport splits the payment by recipient and the buckets sum to the total", async () => {
    const dayHab = await programId("DAY_HAB");
    const ind = unwrap(await createIndividual(pool, { displayName: "Chava Roth" }, ACTOR));
    const emp = unwrap(await createEmployee(pool, { displayName: "Miriam Klein" }, ACTOR));

    await insertTransaction({ individualId: ind.id, employeeId: emp.id, programId: dayHab, checkNumber: "1001", hours: "5", employeePayment: "100", paymentRecipient: "employee" });
    await insertTransaction({ individualId: ind.id, employeeId: emp.id, programId: dayHab, checkNumber: "1002", hours: "3", employeePayment: "40", paymentRecipient: "excellent_staffing" });
    await insertTransaction({ individualId: ind.id, employeeId: emp.id, programId: dayHab, checkNumber: "1003", hours: "1", employeePayment: "10", paymentRecipient: null });

    const rows = await employeePayableReport(pool, {});
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(dec(r.totalPayment).toNumber()).toBe(150);
    expect(dec(r.paidToEmployee).toNumber()).toBe(100);
    expect(dec(r.payableByAgency).toNumber()).toBe(40);
    expect(dec(r.unknownRecipient).toNumber()).toBe(10);
    expect(dec(r.physicalHours).toNumber()).toBe(9);
    expect(r.checkCount).toBe(3);
    // Buckets reconcile to the total exactly.
    const bucketSum = dec(r.paidToEmployee).plus(dec(r.payableByAgency)).plus(dec(r.unknownRecipient));
    expect(bucketSum.toNumber()).toBe(dec(r.totalPayment).toNumber());
  });
});
