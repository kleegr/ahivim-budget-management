import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  hasTestDatabase,
  resetSchema,
  testPool,
} from "../support/database";
import { mergeEmployees } from "@/lib/manage/employee-merge";

const suite = hasTestDatabase ? describe : describe.skip;

suite("settlement snapshot guards (real PostgreSQL)", () => {
  beforeAll(resetSchema, 60_000);
  afterAll(closeTestPool);

  it("freezes actioned obligation values and transaction provenance", async () => {
    const pool = testPool();
    const batch = await pool.query<{ id: string }>(
      `INSERT INTO settlement_batches (idempotency_key, action)
       VALUES ('00000000-0000-4000-9000-000000000099', 'immutability_test')
       RETURNING id`,
    );
    const employee = await pool.query<{ id: string }>(
      `INSERT INTO employees (normalized_name, display_name)
       VALUES ('audit employee', 'Audit Employee') RETURNING id`,
    );
    const employeeId = employee.rows[0].id;
    const transaction = await pool.query<{ id: string }>(
      `INSERT INTO payroll_transactions (employee_id, transaction_fingerprint)
       VALUES ($1, 'immutability-source-1') RETURNING id`,
      [employeeId],
    );
    const obligation = await pool.query<{ id: string }>(
      `INSERT INTO settlement_obligations
         (source_key, kind, direction, employee_id, original_amount)
       VALUES ('immutability-obligation-1', 'employee_giveback', 'receivable', $1, 100)
       RETURNING id`,
      [employeeId],
    );
    const obligationId = obligation.rows[0].id;
    await pool.query(
      `INSERT INTO settlement_obligation_transactions
         (settlement_obligation_id, payroll_transaction_id, allocated_amount)
       VALUES ($1, $2, 100)`,
      [obligationId, transaction.rows[0].id],
    );
    await pool.query(
      `INSERT INTO settlement_events
         (settlement_obligation_id, employee_id, event_type, amount, occurred_on)
       VALUES ($1, $2, 'payment', 25, '2026-08-24')`,
      [obligationId, employeeId],
    );

    await expect(pool.query(
      `UPDATE settlement_obligations SET original_amount = 125 WHERE id = $1`,
      [obligationId],
    )).rejects.toThrow(/actioned settlement obligations are immutable/i);
    await expect(pool.query(
      `UPDATE settlement_obligation_transactions
          SET allocated_amount = 90
        WHERE settlement_obligation_id = $1`,
      [obligationId],
    )).rejects.toThrow(/transaction provenance is immutable/i);
    await expect(pool.query(
      `DELETE FROM settlement_obligations WHERE id = $1`,
      [obligationId],
    )).rejects.toThrow(/settlement obligations are immutable/i);
    await expect(pool.query(
      `UPDATE settlement_batches SET action = 'rewritten' WHERE id = $1`,
      [batch.rows[0].id],
    )).rejects.toThrow(/immutable/i);
  });

  it("allows an actioned obligation and its events to follow a person merge", async () => {
    const pool = testPool();
    const people = await pool.query<{ id: string }>(
      `INSERT INTO employees (normalized_name, display_name)
       VALUES ('merge source', 'Merge Source'), ('merge target', 'Merge Target')
       RETURNING id`,
    );
    const sourceId = people.rows[0].id;
    const targetId = people.rows[1].id;
    const obligation = await pool.query<{ id: string }>(
      `INSERT INTO settlement_obligations
         (source_key, kind, direction, employee_id, original_amount)
       VALUES ('immutability-merge-1', 'employee_giveback', 'receivable', $1, 50)
       RETURNING id`,
      [sourceId],
    );
    const obligationId = obligation.rows[0].id;
    await pool.query(
      `INSERT INTO settlement_events
         (settlement_obligation_id, employee_id, event_type, amount, occurred_on)
       VALUES ($1, $2, 'payment', 10, '2026-08-24')`,
      [obligationId, sourceId],
    );

    await expect(pool.query(
      `UPDATE settlement_obligations
          SET employee_id = $1, updated_at = now()
        WHERE id = $2`,
      [targetId, obligationId],
    )).rejects.toThrow(/obligation and event person must match at commit/i);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE settlement_obligations
            SET employee_id = $1, updated_at = now()
          WHERE id = $2`,
        [targetId, obligationId],
      );
      await client.query(
        `UPDATE settlement_events SET employee_id = $1 WHERE settlement_obligation_id = $2`,
        [targetId, obligationId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const identities = await pool.query<{ obligation_employee_id: string; event_employee_id: string }>(
      `SELECT o.employee_id AS obligation_employee_id, e.employee_id AS event_employee_id
         FROM settlement_obligations o
         JOIN settlement_events e ON e.settlement_obligation_id = o.id
        WHERE o.id = $1`,
      [obligationId],
    );
    expect(identities.rows[0]).toEqual({
      obligation_employee_id: targetId,
      event_employee_id: targetId,
    });
  });

  it("keeps settlement obligations and events aligned through the employee merge service", async () => {
    const pool = testPool();
    const people = await pool.query<{ id: string; normalized_name: string }>(
      `INSERT INTO employees (normalized_name, display_name)
       VALUES ('service merge source', 'Service Merge Source'), ('service merge target', 'Service Merge Target')
       RETURNING id, normalized_name`,
    );
    const source = people.rows.find((row) => row.normalized_name === "service merge source")!;
    const target = people.rows.find((row) => row.normalized_name === "service merge target")!;
    const obligation = await pool.query<{ id: string }>(
      `INSERT INTO settlement_obligations
         (source_key, kind, direction, employee_id, original_amount)
       VALUES ('immutability-service-merge-1', 'employee_giveback', 'receivable', $1, 60)
       RETURNING id`,
      [source.id],
    );
    await pool.query(
      `INSERT INTO settlement_events
         (settlement_obligation_id, employee_id, event_type, amount, occurred_on)
       VALUES ($1, $2, 'payment', 15, '2026-08-24')`,
      [obligation.rows[0].id, source.id],
    );

    const merged = await mergeEmployees(pool, { keepId: target.id, mergeId: source.id }, null, "Confirmed duplicate");
    expect(merged).toMatchObject({ ok: true });
    const identities = await pool.query<{ obligation_employee_id: string; event_employee_id: string }>(
      `SELECT o.employee_id AS obligation_employee_id, e.employee_id AS event_employee_id
         FROM settlement_obligations o
         JOIN settlement_events e ON e.settlement_obligation_id = o.id
        WHERE o.id = $1`,
      [obligation.rows[0].id],
    );
    expect(identities.rows[0]).toEqual({
      obligation_employee_id: target.id,
      event_employee_id: target.id,
    });
  });

  it("freezes a correction snapshot even before it receives an event", async () => {
    const pool = testPool();
    const employee = await pool.query<{ id: string }>(
      `INSERT INTO employees (normalized_name, display_name)
       VALUES ('correction employee', 'Correction Employee') RETURNING id`,
    );
    const correction = await pool.query<{ id: string }>(
      `INSERT INTO settlement_obligations
         (source_key, kind, direction, employee_id, original_amount, calculation_metadata)
       VALUES (
         'immutability-correction-1', 'employee_giveback_correction', 'payable', $1, 15,
         '{"adjustmentForObligationId":"00000000-0000-4000-8000-000000000099"}'::jsonb
       ) RETURNING id`,
      [employee.rows[0].id],
    );

    await expect(pool.query(
      `UPDATE settlement_obligations SET original_amount = 20 WHERE id = $1`,
      [correction.rows[0].id],
    )).rejects.toThrow(/actioned settlement obligations are immutable/i);
  });
});
