import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DB_URL, REPRESENTATIVE_ACCOUNTS, passwordFor, assertSafeE2eDatabaseReset, EXPECTED_DISPOSABLE_DB_HOST, RESET_CONFIRMATION } from './fixtures';

async function signIn(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.context().clearCookies(); await page.goto('/signin');
  await page.getByLabel('Email address').fill(email); await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(url => url.pathname !== '/signin');
}
function testPool() {
  assertSafeE2eDatabaseReset({ connectionString: TEST_DB_URL, expectedHost: EXPECTED_DISPOSABLE_DB_HOST, confirmation: RESET_CONFIRMATION });
  return new Pool({ connectionString: TEST_DB_URL });
}
async function openSetup(page: Page) {
  const setup = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Finish setup/ }) }).first();
  if (await setup.getAttribute('open') === null) await setup.locator('summary').first().click();
}

test('People working flow retains bulk selection, shows separate program overruns and monthly plans, and creates an assignment from prior work', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const pool = testPool(); const ids = [randomUUID(), randomUUID()]; const employeeId = randomUUID();
  const prefix = `Working ${ids[0].slice(0, 8)}`; const names = [`${prefix} Alpha`, `${prefix} Beta`];
  try {
    const programs = (await pool.query<{ id: string; code: string; name: string }>("SELECT id,code,name FROM programs WHERE code IN ('SH_COM_HAB','SH_RESPITE','COM_HAB')")).rows;
    const primary = programs.find(program => program.code === 'SH_COM_HAB')!;
    const secondary = programs.find(program => program.code === 'SH_RESPITE')!;
    const outside = programs.find(program => program.code === 'COM_HAB')!;
    const today = (await pool.query<{ today: string }>('SELECT CURRENT_DATE::text AS today')).rows[0].today;
    const year = today.slice(0, 4), renewal = `${Number(year) + 1}-01-01`;
    for (let index = 0; index < ids.length; index++) await pool.query('INSERT INTO individuals(id,display_name,normalized_name,budget_responsibility_by_program) VALUES($1,$2,$3,$4::jsonb)', [ids[index], names[index], names[index].toLowerCase(), JSON.stringify({ [outside.id]: 'unmanaged' })]);
    await pool.query('INSERT INTO employees(id,display_name,normalized_name) VALUES($1,$2,$3)', [employeeId, `${prefix} Employee`, `${prefix.toLowerCase()} employee`]);
    for (const [index, programId, hours] of [[0, primary.id, 120], [0, secondary.id, 10], [0, outside.id, 3], [1, primary.id, 2]] as const) {
      await pool.query("INSERT INTO payroll_transactions(individual_id,employee_id,program_id,period_begin,check_date,imported_hours,imported_rate,imported_amount,payment_recipient,transaction_fingerprint) VALUES($1,$2,$3,$4,$4,$5::numeric,20,$5::numeric * 20,'employee',$6)", [ids[index], employeeId, programId, today, hours, `working-${randomUUID()}`]);
    }
    const source = (await pool.query('SELECT * FROM payroll_transactions WHERE individual_id=ANY($1::uuid[]) ORDER BY id', [ids])).rows;
    await signIn(page);
    for (const [programId, hours] of [[primary.id, '100'], [secondary.id, '300'], [outside.id, '100']]) {
      const response = await page.request.post('/api/program-budgets', { data: { individualId: ids[0], programId, startDate: `${year}-01-01`, endDate: `${year}-12-31`, renewalDate: renewal, authorizedHours: hours } });
      expect(response.ok(), JSON.stringify(await response.json())).toBe(true);
    }
    await page.goto(`/individuals?q=${encodeURIComponent(prefix)}`);
    await expect(page.getByRole('link', { name: names[0], exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Select all 2 filtered people', exact: true }).click();
    await page.getByRole('button', { name: 'Bulk update responsibilities', exact: true }).click();
    const bulk = page.getByRole('dialog', { name: 'Bulk update responsibilities' });
    await expect(bulk.getByText('2 frozen people', { exact: true })).toBeVisible();
    await expect(bulk.getByText(names[0], { exact: false })).toBeVisible();
    await expect(bulk.getByText(names[1], { exact: false })).toBeVisible();
    await bulk.getByLabel('Change general budget responsibility').check();
    await bulk.getByLabel('New responsibility').selectOption('managed');
    await bulk.getByLabel('Reason', { exact: true }).fill('Synthetic owner reviewed the exact filtered people');
    await bulk.getByLabel('I reviewed these people and the chosen fields.').check();
    await bulk.getByRole('button', { name: 'Save this batch once' }).click();
    await expect(bulk.getByRole('alert')).toContainText('Saved 2 people');
    const changed = (await pool.query('SELECT id,budget_responsibility,budget_responsibility_by_program FROM individuals WHERE id=ANY($1::uuid[])', [ids])).rows;
    expect(changed.every(row => row.budget_responsibility === 'managed' && row.budget_responsibility_by_program[outside.id] === 'unmanaged')).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE action='operational_responsibility_changed' AND entity_id=ANY($1::uuid[])", [ids])).rows[0].count).toBe(2);
    await bulk.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('link', { name: names[0], exact: true }).click();
    await expect(page.getByRole('tab', { name: /^Programs & Monthly Plan(?: \d+)?$/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText(`Over authorization: ${primary.name}: -20 hours remaining`, { exact: false })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Monthly actuals and remaining plan' })).toHaveCount(2);
    const monthlyDrill = page.getByRole('region', { name: 'Monthly actuals and remaining plan' }).first().getByRole('link', { name: /^Transactions/ }).first();
    const drillUrl = new URL((await monthlyDrill.getAttribute('href'))!, 'http://localhost');
    expect(drillUrl.searchParams.get('individualId')).toBe(ids[0]);
    expect(drillUrl.searchParams.get('programId')).toBeTruthy();
    expect(drillUrl.searchParams.get('serviceFrom')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(drillUrl.searchParams.get('serviceTo')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await testInfo.attach('people-programs-desktop', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.getByRole('link', { name: 'Show all programs', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Monthly actuals and remaining plan' })).toHaveCount(3);
    await page.getByRole('link', { name: 'Show working programs', exact: true }).click();
    await page.locator(`a[href*="programId=${secondary.id}"][href*="newAssignment=1"]`).click();
    const assignment = page.getByRole('dialog', { name: 'New assignment', exact: true });
    await expect(assignment.getByRole('combobox', { name: 'Employee', exact: true })).toHaveValue(employeeId);
    await expect(assignment.getByRole('combobox', { name: 'Individual', exact: true })).toHaveValue(ids[0]);
    await assignment.getByRole('searchbox', { name: 'Search employees' }).fill('no match for this employee');
    await expect(assignment.getByText('No matching employees. Your selection is retained.')).toBeVisible();
    await expect(assignment.getByRole('combobox', { name: 'Employee', exact: true })).toHaveValue(employeeId);
    await assignment.getByLabel('Starts', { exact: true }).fill(today);
    await assignment.getByLabel('Change reason').fill('Synthetic prior-work follow-up');
    await assignment.getByRole('button', { name: 'Save assignment', exact: true }).click();
    await expect(assignment).toHaveCount(0);
    await page.reload(); await expect(page.getByRole('dialog', { name: 'New assignment' })).toHaveCount(0);
    const duplicate = await page.request.post('/api/assignments', { data: { individualId: ids[0], employeeId, programId: secondary.id, startDate: today } });
    expect(duplicate.status()).toBe(409);
    await page.goto(`/individuals/${ids[0]}`);
    await expect(page.locator(`a[href*="programId=${secondary.id}"]`).filter({ hasText: 'Open existing assignment' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('region', { name: 'Monthly actuals and remaining plan' }).first()).toBeVisible();
    const widths = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
    await testInfo.attach('people-programs-phone', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.getByRole('link', { name: 'Back to people & budgets' }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('q') === prefix && (url.searchParams.get('selected') ?? '').includes(ids[0]) && (url.searchParams.get('selected') ?? '').includes(ids[1]));
    expect((await pool.query('SELECT * FROM payroll_transactions WHERE individual_id=ANY($1::uuid[]) ORDER BY id', [ids])).rows).toEqual(source);
    const planner = REPRESENTATIVE_ACCOUNTS.find(account => account.preset === 'budget_planner')!;
    await signIn(page, planner.email, passwordFor(planner));
    expect((await page.request.post('/api/individuals/bulk-responsibility', { data: { action: 'preview', ids } })).status()).toBe(403);
  } finally {
    await pool.query('DELETE FROM assignments WHERE individual_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM payroll_transactions WHERE individual_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM individuals WHERE id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM employees WHERE id=$1', [employeeId]); await pool.end();
  }
});

test('Saving one program choice preserves two sibling drafts through refresh and a same-field conflict', async ({ page }) => {
  const pool = testPool(); const id = randomUUID();
  try {
    await pool.query('INSERT INTO individuals(id,display_name,normalized_name,budget_responsibility) VALUES($1,$2,$3,$4)', [id, `Draft ${id.slice(0,8)}`, `draft-${id}`, 'managed']);
    const programs = (await pool.query<{ id: string; name: string }>("SELECT id,name FROM programs WHERE code IN ('SH_COM_HAB','SH_RESPITE') ORDER BY code")).rows;
    await signIn(page); await page.goto(`/individuals/${id}?programScope=all`); await openSetup(page);
    await page.getByText('Program responsibility', { exact: true }).click();
    const general = page.getByRole('combobox', { name: 'General budget responsibility', exact: true });
    const first = page.getByRole('combobox', { name: `${programs[0].name} budget responsibility`, exact: true });
    const second = page.getByRole('combobox', { name: `${programs[1].name} budget responsibility`, exact: true });
    await general.selectOption('unmanaged'); await first.selectOption('unmanaged'); await second.selectOption('undecided');
    await page.getByRole('button', { name: `Save ${programs[0].name} budget responsibility`, exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved this responsibility.' })).toBeVisible();
    await expect(general).toHaveValue('unmanaged'); await expect(second).toHaveValue('undecided');
    page.on('dialog', dialog => dialog.accept()); await page.reload(); await openSetup(page);
    await page.getByText('Program responsibility', { exact: true }).click();
    await expect(general).toHaveValue('unmanaged'); await expect(second).toHaveValue('undecided');
    await pool.query("UPDATE individuals SET budget_responsibility='undecided', updated_at=now() WHERE id=$1", [id]);
    await page.getByRole('button', { name: 'Save General budget responsibility', exact: true }).click();
    await expect(page.locator('#main').getByRole('alert')).toContainText('changed');
    await expect(second).toHaveValue('undecided');
    await page.getByRole('button', { name: 'Load current choice and discard this draft' }).click();
    await expect(general).toHaveValue('undecided'); await expect(second).toHaveValue('undecided');
    const finalSave = page.waitForResponse(response => response.url().endsWith(`/api/individuals/${id}/responsibility`) && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: `Save ${programs[1].name} budget responsibility`, exact: true }).click();
    expect((await finalSave).status()).toBe(200);
    const saved = (await pool.query('SELECT budget_responsibility,budget_responsibility_by_program FROM individuals WHERE id=$1', [id])).rows[0];
    expect(saved.budget_responsibility).toBe('undecided');
    expect(saved.budget_responsibility_by_program).toEqual({ [programs[0].id]: 'unmanaged', [programs[1].id]: 'undecided' });
  } finally { await pool.query('DELETE FROM individuals WHERE id=$1', [id]); await pool.end(); }
});
