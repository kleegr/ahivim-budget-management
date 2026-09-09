import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, test, type Locator, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import {
  TEST_DB_URL, EXPECTED_DISPOSABLE_DB_HOST, RESET_CONFIRMATION,
  assertSafeE2eDatabaseReset, REPRESENTATIVE_ACCOUNTS, passwordFor,
} from './fixtures';

async function login(page: Page, preset: string) {
  const account = REPRESENTATIVE_ACCOUNTS.find(row => row.preset === preset)!;
  await page.context().clearCookies();
  await page.goto('/signin');
  await page.getByLabel('Email address').fill(account.email);
  await page.getByLabel('Password').fill(passwordFor(account));
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(url => url.pathname === account.expectedPath);
}

async function downloadedBytes(page: Page, button: Locator) {
  const pending = page.waitForEvent('download');
  await button.click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return { bytes: Buffer.concat(chunks), filename: download.suggestedFilename() };
}

async function readDownload(bytes: Buffer, format: 'csv' | 'xlsx') {
  const workbook = new ExcelJS.Workbook();
  if (format === 'xlsx') await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  else await workbook.csv.read(Readable.from([bytes]), { map: (value: string) => value });
  const sheet = workbook.worksheets[0]!;
  const headers = Array.from({ length: sheet.columnCount }, (_, i) => sheet.getRow(1).getCell(i + 1).text.replace(/^\uFEFF/, ''));
  return Array.from({ length: sheet.rowCount - 1 }, (_, i) => Object.fromEntries(
    headers.map((header, column) => [header, sheet.getRow(i + 2).getCell(column + 1).value]),
  ));
}

const isBlank = (value: unknown) => value === null || value === '';
function moneyCell(row: Record<string, ExcelJS.CellValue>, column: string, expected: number | null) {
  expect(row).toHaveProperty(column);
  if (expected === null) expect(isBlank(row[column])).toBe(true);
  else {
    expect(isBlank(row[column])).toBe(false);
    expect(Number(row[column])).toBe(expected);
  }
}

test('exact transaction selections preserve missing and zero money through rows, checks, CSV and Excel', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  // No schema reset, ambient DATABASE_URL fallback, or cleanup of shared fixtures.
  assertSafeE2eDatabaseReset({ connectionString: TEST_DB_URL, expectedHost: EXPECTED_DISPOSABLE_DB_HOST, confirmation: RESET_CONFIRMATION });
  const pool = new Pool({ connectionString: TEST_DB_URL });
  const person = randomUUID(), sameNamePerson = randomUUID(), emptyPerson = randomUUID();
  const employee = randomUUID(), otherEmployee = randomUUID();
  const tag = randomUUID().slice(0, 8), name = `Export person ${tag}`, worker = `Export worker ${tag}`;
  const prefix = `EXPORT-${tag}`, missing = `${prefix}-MISSING`, mixed = `${prefix}-MIXED`, zero = `${prefix}-ZERO`;
  const transactionIds = Array.from({ length: 8 }, () => randomUUID());
  const exact = new URLSearchParams({ individualId: person, employeeId: employee, periodBeginExact: '2026-09-01', periodEndExact: '2026-09-03', view: 'rows' });
  try {
    const program = (await pool.query<{ id: string }>("SELECT id FROM programs WHERE code='COM_HAB'")).rows[0]!;
    for (const [id, display] of [[person, name], [sameNamePerson, name], [emptyPerson, `Empty export person ${tag}`]]) {
      await pool.query('INSERT INTO individuals(id,display_name,normalized_name) VALUES($1,$2,$3)', [id, display, `export-${id}`]);
    }
    for (const [id, display] of [[employee, worker], [otherEmployee, `Other export worker ${tag}`]]) {
      await pool.query('INSERT INTO employees(id,display_name,normalized_name) VALUES($1,$2,$3)', [id, display, `export-${id}`]);
    }
    const seeds = [
      [person, employee, missing, '2026-09-03', '100', null],
      [person, employee, missing, '2026-09-03', null, null],
      [person, employee, mixed, '2026-09-03', '50', null],
      [person, employee, mixed, '2026-09-03', '100', '30'],
      [person, employee, zero, '2026-09-03', '0', '0'],
      // Reused check number, different employee or period end; same display name, different person.
      [person, otherEmployee, mixed, '2026-09-03', '9999', '0'],
      [person, employee, mixed, '2026-09-05', '8888', '0'],
      [sameNamePerson, employee, `OTHER-${tag}`, '2026-09-03', '7777', '0'],
    ];
    for (const [index, seed] of seeds.entries()) {
      await pool.query(`INSERT INTO payroll_transactions
        (id,individual_id,employee_id,program_id,check_number,period_begin,period_end,check_date,
         imported_hours,imported_amount,spreadsheet_internal_amount,payment_recipient,transaction_fingerprint)
        VALUES($1,$2,$3,$4,$5,'2026-09-01',$6,'2026-09-04',1,$7,$8,'excellent_staffing',$9)`,
      [transactionIds[index], seed[0], seed[1], program.id, seed[2], seed[3], seed[4], seed[5], `export-${transactionIds[index]}`]);
    }

    await login(page, 'owner');
    await page.goto(`/transactions?${exact}`);
    const panel = page.locator('#transactions-workspace-panel');
    const selectedRows = panel.getByRole('checkbox', { name: `Select this transaction for ${name}`, exact: true });
    await expect(selectedRows).toHaveCount(5);
    const zeroRow = panel.locator('tbody tr').filter({ has: page.getByRole('cell', { name: '$0.00', exact: true }) });
    await expect(zeroRow).toHaveCount(1);
    await expect(zeroRow.getByRole('cell', { name: '$0.00', exact: true })).toHaveCount(3);
    for (const [label, amount] of [['Funder billed', '$250.00'], ['Employee base', '$30.00'], ['Agency spread', '$70.00']]) {
      const tile = panel.locator('div.eyebrow').filter({ hasText: new RegExp(`^${label}$`) }).locator('..');
      await expect(tile).toContainText(amount);
      await expect(tile).toContainText('incomplete subtotal');
    }
    // Clearing presentation filters must retain the exact server-selected person and period.
    const reset = panel.getByRole('button', { name: 'Reset filters', exact: true });
    if (await reset.isEnabled()) await reset.click();
    await expect(selectedRows).toHaveCount(5);
    for (const format of ['csv', 'xlsx'] as const) {
      const download = await downloadedBytes(page, panel.getByRole('button', { name: format === 'csv' ? 'Export CSV' : 'Excel', exact: true }));
      expect(download.filename).toMatch(new RegExp(`\\.${format}$`));
      const rows = await readDownload(download.bytes, format);
      expect(rows).toHaveLength(5);
      expect(rows.map(row => row.Individual)).toEqual(Array(5).fill(name));
      expect(rows.reduce((total, row) => total + Number(row['Funder billed'] ?? 0), 0)).toBe(250);
      expect(rows.filter(row => isBlank(row['Funder billed']))).toHaveLength(1);
      expect(rows.filter(row => isBlank(row['Employee base']))).toHaveLength(3);
      const knownZero = rows.find(row => !isBlank(row['Funder billed']) && Number(row['Funder billed']) === 0)!;
      moneyCell(knownZero, 'Employee base', 0);
      moneyCell(knownZero, 'Agency spread', 0);
      await testInfo.attach(`exact-row-selection.${format}`, { body: download.bytes, contentType: format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }

    await page.goto('/transactions?view=checks');
    await page.getByRole('searchbox', { name: 'Search checks', exact: true }).fill(prefix);
    const checks = page.getByRole('table', { name: 'Checks and their billed activity' });
    await expect(checks.locator('tbody tr')).toHaveCount(5);
    const mixedLink = page.locator(`a[href*="employeeId=${employee}"][href*="periodEndExact=2026-09-03"]`).filter({ hasText: '2 services' });
    const mixedRow = checks.getByRole('row').filter({ has: mixedLink }).filter({ hasText: `#${mixed}` });
    await expect(mixedRow).toContainText('$150.00');
    await expect(mixedRow).toContainText('$30.00 · incomplete subtotal');
    await expect(checks.getByRole('row').filter({ hasText: `#${missing}` })).toContainText('Unavailable');
    await expect(checks.getByRole('row').filter({ hasText: `#${zero}` })).toContainText('$0.00');
    for (const format of ['csv', 'xlsx'] as const) {
      const download = await downloadedBytes(page, panel.getByRole('button', { name: format === 'csv' ? 'CSV' : 'Excel', exact: true }));
      const rows = await readDownload(download.bytes, format);
      expect(rows).toHaveLength(5);
      const main = rows.filter(row => row.Employee === worker && row['Period end'] === '2026-09-03');
      expect(main).toHaveLength(3);
      const absent = main.find(row => row['Check #'] === missing)!;
      moneyCell(absent, 'Funder billed', 100);
      expect(absent['Funder billed completeness']).toBe('Incomplete subtotal (1 known, 1 missing)');
      moneyCell(absent, 'Employee base', null);
      moneyCell(absent, 'Agency spread', null);
      expect(absent['Employee base completeness']).toBe('Unavailable');
      const subtotal = main.find(row => row['Check #'] === mixed)!;
      moneyCell(subtotal, 'Funder billed', 150);
      moneyCell(subtotal, 'Employee base', 30);
      moneyCell(subtotal, 'Agency spread', 70);
      expect(subtotal['Employee base completeness']).toBe('Incomplete subtotal (1 known, 1 missing)');
      const knownZero = main.find(row => row['Check #'] === zero)!;
      for (const column of ['Funder billed', 'Employee base', 'Agency spread']) {
        moneyCell(knownZero, column, 0);
        expect(knownZero[`${column} completeness`]).toBe('Complete');
        if (format === 'xlsx') expect(typeof knownZero[column]).toBe('number');
      }
      await testInfo.attach(`check-completeness.${format}`, { body: download.bytes, contentType: format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }
    // Follow the real link and then narrow the same check to the exact person.
    await mixedRow.getByRole('link', { name: 'Review 2 services', exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('employeeId') === employee && url.searchParams.get('periodEndExact') === '2026-09-03' && !!url.searchParams.get('checkIdentity'));
    await expect(selectedRows).toHaveCount(2);
    const narrowed = new URL(page.url());
    narrowed.searchParams.set('individualId', person);
    await page.goto(narrowed.toString());
    await expect(selectedRows).toHaveCount(2);
    narrowed.searchParams.set('individualId', sameNamePerson);
    await page.goto(narrowed.toString());
    await expect(panel.getByRole('checkbox', { name: /^Select this transaction/ })).toHaveCount(0);
    await expect(page.getByText('No transactions match this selection', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export CSV', exact: true })).toHaveCount(0);
    await page.goto(`/transactions?individualId=${emptyPerson}`);
    await expect(panel.getByRole('checkbox', { name: /^Select this transaction/ })).toHaveCount(0);
    await expect(page.getByText('No transactions match this selection', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export CSV', exact: true })).toHaveCount(0);

    // A real scoped login must reject direct export attempts, including hidden money columns.
    await login(page, 'individual_parent');
    for (const format of ['csv', 'xlsx']) {
      const response = await page.request.post('/api/transactions/export', { data: {
        format, columns: [{ key: 'internalAmount', header: 'Employee base', type: 'money' }],
        rows: [{ id: transactionIds[0], internalAmount: '9999' }],
      } });
      expect(response.status()).toBe(403);
      expect(response.headers()['content-type']).not.toMatch(/csv|spreadsheet/);
    }
  } finally {
    await pool.query('DELETE FROM payroll_transactions WHERE id = ANY($1::uuid[])', [transactionIds]);
    await pool.query('DELETE FROM individuals WHERE id = ANY($1::uuid[])', [[person, sameNamePerson, emptyPerson]]);
    await pool.query('DELETE FROM employees WHERE id = ANY($1::uuid[])', [[employee, otherEmployee]]);
    await pool.end();
  }
});
