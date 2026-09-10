import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { listTransactionsForGrid } from "@/lib/data/transactions-grid";
import { fullAccess } from "@/lib/auth/access";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
suite("transaction budget credit uses the canonical authorization rate", () => {
  beforeAll(resetSchema, 60_000);
  afterAll(closeTestPool);
  it("keeps 12.25 imported hours while crediting 833 / 17 = 49, and removes budget facts when access is denied", async () => {
    const pool = testPool();
    const person = (await pool.query<{ id: string }>("INSERT INTO individuals(normalized_name,display_name) VALUES('credit-test','Credit test') RETURNING id")).rows[0]!;
    const program = (await pool.query<{ id: string }>(`INSERT INTO programs(code,name,required_auth_type,consumption_source,rate_scope)
      VALUES('CREDIT_GROUP','Credit group','hours','payroll','per_group') RETURNING id`)).rows[0]!;
    const period = (await pool.query<{ id: string }>(`INSERT INTO budget_periods(individual_id,label,start_date,end_date)
      VALUES($1,'Credit period','2026-01-01','2026-12-31') RETURNING id`, [person.id])).rows[0]!;
    await pool.query(`INSERT INTO budget_authorizations(budget_period_id,individual_id,program_id,authorized_hours,internal_rate)
      VALUES($1,$2,$3,100,17)`, [period.id, person.id, program.id]);
    await pool.query(`INSERT INTO payroll_transactions(individual_id,program_id,period_begin,period_end,check_date,
      imported_hours,spreadsheet_internal_amount,transaction_fingerprint)
      VALUES($1,$2,'2026-09-01','2026-09-03','2026-09-04',12.25,833,'canonical-credit-proof')`, [person.id, program.id]);
    const rows = await listTransactionsForGrid(pool);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.hours)).toBe(12.25);
    expect(Number(rows[0]!.creditedBudgetHours)).toBe(49);
    expect(Number(rows[0]!.budgetCreditRate)).toBe(17);
    expect(rows[0]!.budgetCreditBasis).toBe("Employee base divided by authorization rate");
    const hidden = await listTransactionsForGrid(pool, { ...fullAccess("credit-test", "admin"), canSeeBudgets: false });
    expect(hidden[0]).not.toHaveProperty("creditedBudgetHours");
    expect(hidden[0]).not.toHaveProperty("budgetCreditRate");
    expect(hidden[0]).not.toHaveProperty("budgetCreditBasis");
  });
});
