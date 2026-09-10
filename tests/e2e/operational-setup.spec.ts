import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DB_URL, REPRESENTATIVE_ACCOUNTS, passwordFor, LINKED_INDIVIDUAL_ID, LINKED_EMPLOYEE_ID, assertSafeE2eDatabaseReset, EXPECTED_DISPOSABLE_DB_HOST, RESET_CONFIRMATION } from './fixtures';

async function signIn(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.context().clearCookies(); await page.goto('/signin');
  await page.getByLabel('Email address').fill(email); await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.pathname !== '/signin');
}
async function saveChoice(page: Page, label: string, value: string) {
  const setup = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Finish setup/ }) }).first();
  if (label.endsWith('budget responsibility')) {
    await page.waitForURL(url => /^\/individuals\/[^/]+$/.test(url.pathname), { waitUntil: 'load' });
    // A profile Link can finish clicking before its next server page arrives.
    // Wait for setup instead of treating a momentary zero count as no setup.
    await expect(setup).toBeVisible();
    if (await setup.getAttribute('open') === null) await setup.locator('summary').first().click();
  }
  await page.getByRole('combobox', { name: label, exact: true }).selectOption(value);
  const saved = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/responsibility') && response.request().method() === 'PATCH' && response.request().postDataJSON()?.value === value);
  await page.getByRole('button', { name: `Save ${label}`, exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: 'Saved this responsibility.' }).first()).toBeVisible();
}
function testPool() {
  assertSafeE2eDatabaseReset({ connectionString: TEST_DB_URL, expectedHost: EXPECTED_DISPOSABLE_DB_HOST, confirmation: RESET_CONFIRMATION });
  return new Pool({ connectionString: TEST_DB_URL });
}

test('Owner manages mixed program responsibility and corrects the flagged renewal without losing directory context', async ({ page }) => {
  test.setTimeout(120_000);
  const pool = testPool(); const id = randomUUID(), employeeId = randomUUID();
  const name = `Responsibility person ${id.slice(0, 8)}`;
  try {
    const programs = (await pool.query<{ id: string; name: string; code: string }>("SELECT id,name,code FROM programs WHERE code IN ('COM_HAB','RESPITE') ORDER BY code")).rows;
    const today = (await pool.query<{ today: string }>('SELECT CURRENT_DATE::text AS today')).rows[0].today;
    const renewal = `${Number(today.slice(0, 4)) + 1}-01-01`;
    await pool.query('INSERT INTO individuals(id,display_name,normalized_name) VALUES($1,$2,$3)', [id, name, name.toLowerCase()]);
    await pool.query("INSERT INTO employees(id,display_name,normalized_name) VALUES($1,'Responsibility worker',$2)", [employeeId, `responsibility-${employeeId}`]);
    await pool.query(`INSERT INTO payroll_transactions(individual_id,employee_id,program_id,period_begin,check_date,imported_hours,imported_rate,imported_amount,payment_recipient,transaction_fingerprint) VALUES($1,$2,$3,$4,$4,2,25,50,'agency',$5)`, [id, employeeId, programs[0].id, today, `responsibility-${id}`]);
    const source = (await pool.query('SELECT * FROM payroll_transactions WHERE individual_id=$1', [id])).rows;
    await signIn(page);
    await page.goto(`/individuals?programScope=all&q=${encodeURIComponent(name)}`);
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('Not decided yet');
    await page.getByRole('link', { name, exact: true }).click();
    await saveChoice(page, 'General budget responsibility', 'unmanaged');
    await expect(page.getByRole('region', { name: 'Record review' })).toHaveCount(0);
    await page.reload(); await page.locator('summary').filter({ hasText: /^Finish setup/ }).click(); await expect(page.getByRole('combobox', { name: 'General budget responsibility', exact: true })).toHaveValue('unmanaged');
    await page.getByRole('link', { name: 'Back to people & budgets' }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get("q") === name);
    await expect(page.getByRole('row').filter({ hasText: name })).not.toContainText('Needs budget');
    await page.getByRole('combobox', { name: 'Budget responsibility', exact: true }).selectOption('unmanaged');
    await page.getByRole('link', { name, exact: true }).click();
    await saveChoice(page, 'General budget responsibility', 'managed');
    await expect(page.getByRole('link', { name: 'Add budget', exact: true }).first()).toBeVisible();
    for (const program of programs) {
      const response = await page.request.post('/api/program-budgets', { data: { individualId: id, programId: program.id, startDate: `${today.slice(0,4)}-01-01`, endDate: `${today.slice(0,4)}-12-31`, authorizedHours: '100' } });
      expect(response.ok(), JSON.stringify(await response.json())).toBe(true);
    }
    await page.reload();
    await page.locator('summary').filter({ hasText: /^Finish setup/ }).click();
    await page.getByText('Program responsibility', { exact: true }).click();
    await saveChoice(page, `${programs[1].name} budget responsibility`, 'unmanaged');
    await page.getByRole('link', { name: 'Set renewal date', exact: true }).first().click();
    const authorization = page.locator('article').filter({ has: page.getByRole('heading', { name: programs[0].name, exact: true }) });
    await authorization.getByRole('button', { name: 'Set renewal', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Set renewal - ${programs[0].name}` });
    await dialog.getByLabel('Renewal date', { exact: true }).fill(renewal);
    await dialog.getByLabel('Change reason').fill('Owner corrected the managed renewal');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Renewal saved. Budget and review state updated.' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Record review' })).toHaveCount(0);
    await expect(page.locator('article')).toHaveCount(1);
    await page.getByRole('link', { name: 'Show all programs', exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('programScope') === 'all', { waitUntil: 'load' });
    for (const program of programs) {
      await page.getByRole('tab', { name: program.name, exact: true }).click();
      await expect(page.locator('article').getByRole('heading', { name: program.name, exact: true })).toBeVisible();
    }
    await expect(page.locator('article')).toHaveCount(1);
    expect((await pool.query('SELECT * FROM payroll_transactions WHERE individual_id=$1', [id])).rows).toEqual(source);
    expect((await pool.query('SELECT count(*)::int AS count FROM budget_authorizations WHERE individual_id=$1', [id])).rows[0].count).toBe(2);
    await signIn(page); await page.goto(`/individuals/${id}`);
    const saved = await (await page.request.get(`/api/individuals/${id}/responsibility`)).json();
    expect(saved.data.budget).toBe('managed'); expect(saved.data.programs[programs[1].id]).toBe('unmanaged');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('summary').filter({ hasText: /^Finish setup/ }).click();
    await expect(page.getByRole('combobox', { name: 'General budget responsibility' })).toBeVisible();
    const widths = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  } finally {
    await pool.query('DELETE FROM payroll_transactions WHERE individual_id=$1', [id]);
    await pool.query('DELETE FROM individuals WHERE id=$1', [id]); await pool.query('DELETE FROM employees WHERE id=$1', [employeeId]); await pool.end();
  }
});

test('Employee operational choices are independent, persistent, searchable, and leave financial history intact', async ({ page }) => {
  const pool = testPool(); const id = randomUUID(), name = `Responsibility employee ${id.slice(0, 8)}`;
  try {
    await pool.query('INSERT INTO employees(id,display_name,normalized_name,payout_cut_percent) VALUES($1,$2,$3,0.15)', [id,name,name.toLowerCase()]);
    await pool.query(`INSERT INTO payroll_transactions(employee_id,check_date,imported_amount,payment_recipient,transaction_fingerprint) VALUES($1,CURRENT_DATE,125,'employee',$2)`, [id, `employee-responsibility-${id}`]);
    const source = (await pool.query('SELECT * FROM payroll_transactions WHERE employee_id=$1', [id])).rows;
    await signIn(page); await page.goto(`/employees/${id}`);
    await page.getByRole('combobox', { name: 'Scheduling responsibility' }).selectOption('managed');
    await page.getByRole('combobox', { name: 'Money operations responsibility' }).selectOption('unmanaged');
    await page.getByRole('button', { name: 'Save Scheduling responsibility', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved this responsibility.' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Money operations responsibility' })).toHaveValue('unmanaged');
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Money operations responsibility' })).toHaveValue('unmanaged');
    await saveChoice(page, 'Money operations responsibility', 'unmanaged');
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Scheduling responsibility' })).toHaveValue('managed');
    await expect(page.getByRole('combobox', { name: 'Money operations responsibility' })).toHaveValue('unmanaged');
    await expect(page.getByRole('link', { name: 'Review arrangements', exact: true })).toBeVisible();
    await page.goto(`/employees?q=${encodeURIComponent(name)}&management=unmanaged&workflow=money`);
    await page.getByRole('link', { name, exact: true }).click(); await page.getByRole('link', { name: 'Back to employees', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Search employees' })).toHaveValue(name);
    await expect(page.getByRole('combobox', { name: 'Responsibility area' })).toHaveValue('money');
    await expect(page.getByRole('combobox', { name: 'Management', exact: true })).toHaveValue('unmanaged');
    expect((await pool.query('SELECT * FROM payroll_transactions WHERE employee_id=$1', [id])).rows).toEqual(source);
    expect((await pool.query('SELECT payout_cut_percent FROM employees WHERE id=$1', [id])).rows[0].payout_cut_percent).toBe('0.150000');
    expect((await pool.query('SELECT count(*)::int AS count FROM employee_deals WHERE employee_id=$1', [id])).rows[0].count).toBe(0);
    await signIn(page); await page.goto(`/employees/${id}`);
    await expect(page.getByRole('combobox', { name: 'Money operations responsibility' })).toHaveValue('unmanaged');
  } finally { await pool.query('DELETE FROM payroll_transactions WHERE employee_id=$1',[id]); await pool.query('DELETE FROM employees WHERE id=$1',[id]); await pool.end(); }
});

test('Home review is compact on phone and unauthorized roles cannot read or change operational choices', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/dashboard');
  const summary = page.getByRole('region', { name: 'Needs attention', exact: true });
  await expect(summary).toBeVisible();
  await expect(summary.getByText(/individuals? with detected issues/)).toBeVisible();
  await expect(summary.getByText(/employees? with detected issues/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs attention', exact: true })).toHaveCount(1);
  const widths = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
  for (const preset of ['budget_planner','staffing_manager','money_collector','employee','agency'] as const) {
    const account = REPRESENTATIVE_ACCOUNTS.find((candidate) => candidate.preset === preset)!;
    await signIn(page, account.email, passwordFor(account));
    for (const [kind, id, field] of [['individuals',LINKED_INDIVIDUAL_ID,'budget'], ['employees',LINKED_EMPLOYEE_ID,'money']]) {
      const endpoint = `/api/${kind}/${id}/responsibility`;
      expect((await page.request.get(endpoint)).status()).toBe(403);
      expect((await page.request.patch(endpoint, { data: { field, value: 'managed' } })).status()).toBe(403);
    }
    if (preset === 'budget_planner' || preset === 'staffing_manager') {
      await page.goto(`/individuals/${LINKED_INDIVIDUAL_ID}`);
      await expect(page.getByRole('combobox', { name: 'General budget responsibility' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Record review' })).toHaveCount(0);
    }
  }
});
