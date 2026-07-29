import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testPool, resetSchema, truncateBusinessTables, closeTestPool } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { createIndividual } from "@/lib/manage/individuals";
import { createEmployee } from "@/lib/manage/employees";
import { backfillPaymentAttribution } from "@/lib/manage/payment-attribution";
import { dec } from "@/lib/money";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

function unwrap<T>(r: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data;
}

interface TxInput {
  individualId: string;
  employeeId: string;
  payToRaw: string | null;
  importedAmount?: string | null;
  calculatedInternal?: string | null;
  spreadsheetInternal?: string | null;
  internalRateApplied?: string | null;
  importedHours?: string | null;
  fingerprint: string;
}

async function insertTx(input: TxInput): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payroll_transactions
       (individual_id, employee_id, pay_to_raw, imported_amount, imported_hours,
        calculated_internal_amount, spreadsheet_internal_amount, internal_rate_applied,
        transaction_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      input.individualId,
      input.employeeId,
      input.payToRaw,
      input.importedAmount ?? null,
      input.importedHours ?? null,
      input.calculatedInternal ?? null,
      input.spreadsheetInternal ?? null,
      input.internalRateApplied ?? null,
      input.fingerprint,
    ],
  );
  return rows[0]!.id;
}

async function readTx(id: string) {
  const { rows } = await pool.query<{
    payment_recipient: string | null;
    employee_payment_amount: string | null;
    agency_additional_amount: string | null;
    imported_amount: string | null;
  }>(
    `SELECT payment_recipient, employee_payment_amount::text AS employee_payment_amount,
            agency_additional_amount::text AS agency_additional_amount,
            imported_amount::text AS imported_amount
       FROM payroll_transactions WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

suite("payment attribution back-fill (real PostgreSQL)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role) VALUES ($1,$2,$3,'x','admin')`,
      [ACTOR, "a@a.test", "Admin"],
    );
  });
  afterAll(closeTestPool);

  async function people() {
    const ind = unwrap(await createIndividual(pool, { displayName: "Aaron Levy" }, ACTOR));
    const emp = unwrap(await createEmployee(pool, { displayName: "Miriam Klein" }, ACTOR));
    return { ind, emp };
  }

  it("populates the three columns and sets agency additional = imported − internal", async () => {
    const { ind, emp } = await people();
    const id = await insertTx({
      individualId: ind.id,
      employeeId: emp.id,
      payToRaw: "Excellent Staffing",
      importedAmount: "19",
      calculatedInternal: "17",
      fingerprint: "fp-agency-1",
    });

    const updated = await backfillPaymentAttribution(pool, {}, ACTOR);
    expect(updated).toBe(1);

    const row = await readTx(id);
    expect(row.payment_recipient).toBe("excellent_staffing");
    expect(dec(row.agency_additional_amount).toNumber()).toBe(2); // 19 − 17
    // Not paid to the employee, so no employee payment is recorded.
    expect(row.employee_payment_amount).toBeNull();

    // An audit row is written for the back-fill.
    const audit = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_logs WHERE action = 'payment_attributed'`,
    );
    expect(Number(audit.rows[0]!.c)).toBe(1);
  });

  it("attributes a payee that matches the employee, recording the internal amount as their payment", async () => {
    const { ind, emp } = await people();
    const id = await insertTx({
      individualId: ind.id,
      employeeId: emp.id,
      payToRaw: "Klein, Miriam", // Last, First — still matches "Miriam Klein"
      importedAmount: "19",
      calculatedInternal: "17",
      fingerprint: "fp-employee-1",
    });

    await backfillPaymentAttribution(pool, {}, ACTOR);

    const row = await readTx(id);
    expect(row.payment_recipient).toBe("employee");
    expect(dec(row.employee_payment_amount!).toNumber()).toBe(17);
    expect(dec(row.agency_additional_amount).toNumber()).toBe(2);
  });

  it("resolves the internal amount from the rate × hours fallback and never touches imported_amount", async () => {
    const { ind, emp } = await people();
    const id = await insertTx({
      individualId: ind.id,
      employeeId: emp.id,
      payToRaw: "Some Vendor",
      importedAmount: "38",
      internalRateApplied: "17",
      importedHours: "2", // internal falls back to 17 × 2 = 34
      fingerprint: "fp-fallback-1",
    });

    await backfillPaymentAttribution(pool, {}, ACTOR);

    const row = await readTx(id);
    expect(row.payment_recipient).toBe("unknown");
    expect(dec(row.agency_additional_amount).toNumber()).toBe(4); // 38 − 34
    expect(row.imported_amount).toBe("38.0000"); // imported value untouched
  });

  it("scopes the back-fill to a single batch when a batchId is given", async () => {
    const { ind, emp } = await people();
    const { rows: batchRows } = await pool.query<{ id: string }>(
      `INSERT INTO imported_files (original_filename, byte_size, checksum_sha256)
         VALUES ('x.xlsx', 1, 'sum-1') RETURNING id`,
    );
    const fileId = batchRows[0]!.id;
    const { rows: b } = await pool.query<{ id: string }>(
      `INSERT INTO import_batches (imported_file_id, status) VALUES ($1, 'committed') RETURNING id`,
      [fileId],
    );
    const batchId = b[0]!.id;

    const inBatch = await pool.query<{ id: string }>(
      `INSERT INTO payroll_transactions
         (individual_id, employee_id, import_batch_id, pay_to_raw, imported_amount,
          calculated_internal_amount, transaction_fingerprint)
       VALUES ($1,$2,$3,'Excellent Staffing','19','17','fp-in-batch') RETURNING id`,
      [ind.id, emp.id, batchId],
    );
    const outOfBatch = await insertTx({
      individualId: ind.id,
      employeeId: emp.id,
      payToRaw: "Excellent Staffing",
      importedAmount: "19",
      calculatedInternal: "17",
      fingerprint: "fp-out-of-batch",
    });

    const updated = await backfillPaymentAttribution(pool, { batchId }, ACTOR);
    expect(updated).toBe(1);

    const inside = await readTx(inBatch.rows[0]!.id);
    expect(inside.payment_recipient).toBe("excellent_staffing");
    const outside = await readTx(outOfBatch);
    expect(outside.payment_recipient).toBeNull(); // untouched
  });
});
