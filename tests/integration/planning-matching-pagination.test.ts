import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fullAccess, type AccessScope } from "@/lib/auth/access";
import { getPlanningMatchReview } from "@/lib/data/planning-reconciliation";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
suite("complete schedule match queue (synthetic PostgreSQL)", () => {
  let person: string; let employee: string; let program: string; let oldest: string; let scope: AccessScope;
  beforeAll(async () => {
    await resetSchema();
    const pool = testPool();
    person = (await pool.query<{ id: string }>("INSERT INTO individuals (display_name, normalized_name) VALUES ('Queue Person', 'queue person') RETURNING id")).rows[0]!.id;
    employee = (await pool.query<{ id: string }>("INSERT INTO employees (display_name, normalized_name) VALUES ('Queue Employee', 'queue employee') RETURNING id")).rows[0]!.id;
    program = (await pool.query<{ id: string }>("INSERT INTO programs (code, name) VALUES ('QUEUE_SCALE', 'Queue service') RETURNING id")).rows[0]!.id;
    await pool.query(`WITH visits AS (
      INSERT INTO scheduled_sessions (program_id, employee_id, session_date, duration_hours, status)
      SELECT $1, $2, '2026-01-01'::date + n, 2, 'pending' FROM generate_series(1, 251) n RETURNING id
    ) INSERT INTO scheduled_allocations (scheduled_session_id, individual_id, allocation_hours) SELECT id, $3, 2 FROM visits`, [program, employee, person]);
    oldest = (await pool.query<{ id: string }>("SELECT id FROM scheduled_sessions ORDER BY session_date LIMIT 1")).rows[0]!.id;
    const oldEmployee = (await pool.query<{ id: string }>("INSERT INTO employees (display_name, normalized_name) VALUES ('Needle Older Worker', 'needle older worker') RETURNING id")).rows[0]!.id;
    await pool.query("UPDATE scheduled_sessions SET employee_id=$1 WHERE id=$2", [oldEmployee, oldest]);
    const hidden = (await pool.query<{ id: string }>("INSERT INTO individuals (display_name, normalized_name) VALUES ('Hidden Queue Person', 'hidden queue person') RETURNING id")).rows[0]!.id;
    await pool.query(`WITH visit AS (INSERT INTO scheduled_sessions (program_id, employee_id, session_date, duration_hours) VALUES ($1, $2, '2026-09-09', 2) RETURNING id)
      INSERT INTO scheduled_allocations (scheduled_session_id, individual_id, allocation_hours) SELECT id,$3,2 FROM visit`, [program, employee, hidden]);
    scope = { ...fullAccess("00000000-0000-4000-8000-000000000099", "viewer"), full: false, allIndividuals: false, allEmployees: false, individualIds: [person], employeeIds: [employee, oldEmployee], grantedIndividualIds: [person], grantedEmployeeIds: [employee, oldEmployee], canSeeTransactions: false, canSeeMoney: false };
  }, 60_000);
  afterAll(closeTestPool);

  it("reaches record 251 and searches before pagination without exposing other people", async () => {
    const first = await getPlanningMatchReview(testPool(), "2026-09-09", scope, [], 100);
    const second = await getPlanningMatchReview(testPool(), "2026-09-09", scope, [], 100, { page: 2 });
    const third = await getPlanningMatchReview(testPool(), "2026-09-09", scope, [], 100, { page: 3 });
    expect([first.rows.length, second.rows.length, third.rows.length]).toEqual([100, 100, 51]);
    expect(first.total).toBe(251);
    expect(new Set([...first.rows, ...second.rows, ...third.rows].map((row) => row.id)).size).toBe(251);
    expect(third.rows.at(-1)?.id).toBe(oldest);
    const search = await getPlanningMatchReview(testPool(), "2026-09-09", scope, [], 100, { query: "Needle Older" });
    expect(search.rows.map((row) => row.id)).toEqual([oldest]); expect(search.total).toBe(1);
    expect((await getPlanningMatchReview(testPool(), "2026-09-09", scope, [], 100, { query: "Hidden Queue" })).rows).toEqual([]);
    expect(JSON.stringify(search)).not.toMatch(/imported_amount|checkNumber|gross|rate|transactionId/);
  });

  it("never proposes an actual already matched to another visit", async () => {
    const pool = testPool();
    const actual = (await pool.query<{ id: string }>(`INSERT INTO payroll_transactions (individual_id, employee_id, program_id, period_begin, period_end, imported_hours, transaction_fingerprint)
      SELECT $1, employee_id, $2, session_date, session_date, 2, 'queue-scale-actual' FROM scheduled_sessions WHERE id=$3 RETURNING id`, [person, program, oldest])).rows[0]!.id;
    const before = await getPlanningMatchReview(pool, "2026-09-09", scope, [], 100, { query: "Needle Older" });
    expect(before.rows[0]?.candidateCount).toBe(1);
    await pool.query("UPDATE scheduled_sessions SET matched_transaction_id=$1 WHERE id=(SELECT id FROM scheduled_sessions WHERE id<>$2 ORDER BY session_date LIMIT 1)", [actual, oldest]);
    const after = await getPlanningMatchReview(pool, "2026-09-09", scope, [], 100, { query: "Needle Older" });
    expect(after.rows[0]?.candidateCount).toBe(0);
  });
});
