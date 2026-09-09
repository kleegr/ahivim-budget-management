import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from '../support/database';
import { listEmployeeResponsibilities, listIndividualResponsibilities, saveOperationalResponsibility } from '@/lib/manage/operational-responsibility';
import { listIndividualOperationalReviews, getOperationalReviewSummary } from '@/lib/data/operational-review';
import { createProgramBudget } from '@/lib/manage/program-budgets';
import { updateBudgetPeriodRenewal } from '@/lib/manage/authorizations';
import { runSheetSync } from '@/lib/sheets/sync';

const suite = hasTestDatabase ? describe : describe.skip;
const actor = randomUUID(), person = randomUUID(), employee = randomUUID();
let program: string;
const unwrap = <T>(value: { ok: true; data: T } | { ok: false; message: string }): T => { if (!value.ok) throw new Error(value.message); return value.data; };

suite('operational choices on isolated PostgreSQL', () => {
  beforeAll(async () => {
    await resetSchema();
    const pool = testPool();
    await pool.query(`INSERT INTO users(id,email,display_name,password_hash,role) VALUES($1,'operations@test.invalid','Owner','x','admin')`, [actor]);
    await pool.query(`INSERT INTO individuals(id,normalized_name,display_name) VALUES($1,'operational person','Operational Person')`, [person]);
    await pool.query(`INSERT INTO employees(id,normalized_name,display_name) VALUES($1,'operational employee','Operational Employee')`, [employee]);
    program = (await pool.query<{ id: string }>("SELECT id FROM programs WHERE code = 'COM_HAB'")).rows[0].id;
  }, 60_000);
  afterAll(closeTestPool);

  it('rehearses the additive upgrade against populated data without changing prior business values', async () => {
    const client = await testPool().connect();
    const tables = ['individuals','employees','agency_individuals','budget_authorizations','calculation_strategies','payroll_transactions','employee_deals','settlement_obligations','settlement_events','document_versions'];
    const snapshot = async () => {
      const result = [];
      for (const table of tables) result.push((await client.query(`SELECT to_jsonb(record) - 'budget_responsibility' - 'budget_responsibility_by_program' - 'scheduling_responsibility' - 'money_responsibility' AS fact FROM ${table} record ORDER BY id`)).rows);
      return result;
    };
    try {
      await client.query('BEGIN');
      const before = await snapshot();
      await client.query('ALTER TABLE individuals DROP COLUMN budget_responsibility, DROP COLUMN budget_responsibility_by_program');
      await client.query('ALTER TABLE employees DROP COLUMN scheduling_responsibility, DROP COLUMN money_responsibility');
      await client.query(readFileSync('drizzle/0048_operational_responsibility.sql', 'utf8'));
      expect(await snapshot()).toEqual(before);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('preserves explicit agency choices but does not infer a decision or grant a membership', async () => {
    const pool = testPool();
    expect((await listIndividualResponsibilities(pool, '2026-09-08', person)).get(person)?.budget).toBe('undecided');
    const home = (await pool.query<{ id: string }>('SELECT id FROM agencies WHERE is_home_agency')).rows[0].id;
    await pool.query(`INSERT INTO agency_individuals(agency_id,individual_id,manages_budget,bills_services,effective_from,created_by_user_id) VALUES($1,$2,false,true,'2026-01-01',$3)`, [home, person, actor]);
    expect((await listIndividualResponsibilities(pool, '2026-09-08', person)).get(person)).toMatchObject({ budget: 'unmanaged', source: 'agency' });
    const before = (await pool.query('SELECT * FROM agency_individuals WHERE individual_id=$1', [person])).rows;
    unwrap(await saveOperationalResponsibility(pool, 'individual', person, { field: 'budget', value: 'managed' }, actor));
    expect((await pool.query('SELECT * FROM agency_individuals WHERE individual_id=$1', [person])).rows).toEqual(before);
    expect((await listIndividualOperationalReviews(pool, '2026-09-08', person)).get(person)?.flags[0].key).toBe('missing-budget');
  });

  it('corrects a managed renewal through the existing mutation and refreshes the exact review', async () => {
    const pool = testPool();
    const created = unwrap(await createProgramBudget(pool, { individualId: person, programId: program, startDate: '2026-01-01', endDate: '2026-12-31', authorizedHours: '100', internalRate: '20', agencyRate: '25' }, actor));
    const flags = (await listIndividualOperationalReviews(pool, '2026-09-08', person)).get(person)!.flags;
    expect(flags.some((flag) => flag.key === `renewal-missing-${created.authorizationId}`)).toBe(true);
    unwrap(await updateBudgetPeriodRenewal(pool, created.budgetPeriodId, '2027-01-01', actor, 'Owner corrected renewal'));
    expect((await listIndividualOperationalReviews(pool, '2026-09-08', person)).get(person)!.flags).toEqual([]);
    const before = (await pool.query('SELECT * FROM budget_authorizations WHERE individual_id=$1', [person])).rows;
    unwrap(await saveOperationalResponsibility(pool, 'individual', person, { field: 'budget', value: 'unmanaged', programId: program }, actor));
    expect((await listIndividualResponsibilities(pool, '2026-09-08', person)).get(person)?.programs[program]).toBe('unmanaged');
    expect((await pool.query('SELECT * FROM budget_authorizations WHERE individual_id=$1', [person])).rows).toEqual(before);
  });

  it('saves independent employee choices without changing payment routing, deals, or obligations', async () => {
    const pool = testPool();
    await pool.query(`INSERT INTO payroll_transactions(individual_id,employee_id,program_id,check_date,payment_recipient,imported_amount,transaction_fingerprint) VALUES($1,$2,$3,'2026-09-01','employee',50,'operational-routing')`, [person, employee, program]);
    const before = await Promise.all(['payroll_transactions','employee_deals','settlement_obligations','settlement_events'].map(async (table) => (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows));
    unwrap(await saveOperationalResponsibility(pool, 'employee', employee, { field: 'scheduling', value: 'managed' }, actor));
    unwrap(await saveOperationalResponsibility(pool, 'employee', employee, { field: 'money', value: 'unmanaged' }, actor));
    expect((await listEmployeeResponsibilities(pool, employee)).get(employee)).toEqual({ scheduling: 'managed', money: 'unmanaged' });
    const after = await Promise.all(['payroll_transactions','employee_deals','settlement_obligations','settlement_events'].map(async (table) => (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows));
    expect(after).toEqual(before);
    expect((await getOperationalReviewSummary(pool, '2026-09-08')).employees).toBeGreaterThanOrEqual(1);
  });

  it('preserves choices and business rows across a real unchanged inbound sync', async () => {
    const pool = testPool();
    const totals = Array(20).fill(''); totals[16] = '50';
    const header = Array(20).fill(''); header[0] = 'Pay to'; header[3] = 'Code'; header[10] = 'Paid CC2 Description'; header[11] = 'Paid CC3 Description'; header[12] = 'Employee Memo';
    const row = Array(20).fill(''); row[0] = 'Excellent Staffing'; row[1] = '09/08/2026'; row[2] = 'OPS-SYNC-1'; row[4] = '2'; row[5] = '25'; row[6] = '50'; row[8] = '09/01/2026'; row[9] = '09/07/2026'; row[10] = 'Com Hab'; row[11] = 'Operational Person'; row[12] = 'Operational Employee';
    const csv = [totals,header,row].map((cells) => cells.map((cell) => `"${cell}"`).join(',')).join('\n');
    const options = { trigger: 'manual' as const, userId: actor, fetcher: async () => csv, config: { enabled: true, sheetId: 'ISOLATED_OPERATIONS', sheetName: 'Ahivim', scheduleHourUtc: 8, minIntervalMinutes: 0 } };
    expect((await runSheetSync(pool, options)).status).toBe('success');
    unwrap(await saveOperationalResponsibility(pool, 'individual', person, { field: 'budget', value: 'undecided' }, actor));
    const before = (await pool.query('SELECT * FROM payroll_transactions ORDER BY id')).rows;
    const run = await runSheetSync(pool, options);
    expect(run.status).toBe('no_changes'); expect(run.added).toBe(0);
    expect((await pool.query('SELECT * FROM payroll_transactions ORDER BY id')).rows).toEqual(before);
    expect((await listIndividualResponsibilities(pool, '2026-09-08', person)).get(person)).toMatchObject({ budget: 'undecided', programs: { [program]: 'unmanaged' } });
    expect((await listEmployeeResponsibilities(pool, employee)).get(employee)).toEqual({ scheduling: 'managed', money: 'unmanaged' });
  });
});
