import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { expect, test, type Response } from '@playwright/test';
import ExcelJS from 'exceljs';
import Decimal from 'decimal.js';
import { Pool } from 'pg';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DB_URL, EXPECTED_DISPOSABLE_DB_HOST, RESET_CONFIRMATION, assertSafeE2eDatabaseReset } from './fixtures';

test('Owner opens Transactions from Reports, pages a large result, and exports every matching source row', async ({ page }, testInfo) => {
  // This is a bounded journey timeout, not a performance SLA. Actual elapsed
  // timings are attached even when an assertion fails.
  test.setTimeout(240_000);
  assertSafeE2eDatabaseReset({ connectionString: TEST_DB_URL, expectedHost: EXPECTED_DISPOSABLE_DB_HOST, confirmation: RESET_CONFIRMATION });
  const target = new URL(TEST_DB_URL);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(target.hostname);
  expect(target.pathname).toBe('/ahivim_e2e');
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  const person = randomUUID(), employee = randomUUID(), program = randomUUID();
  const tag = randomUUID(), personName = `Report person ${tag}`, workerName = `Report worker ${tag}`;
  const ids = Array.from({ length: 2000 }, () => randomUUID());
  const check = (index: number) => `REPORT-${tag}-${String(index + 1).padStart(5, '0')}`;
  const reportResponses: Response[] = [];
  const pageErrors: string[] = [];
  const measurements: Record<string, unknown> = { seededRows: ids.length, personId: person, verified: false };
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path === '/reports/transactions' || path === '/api/grid/export') reportResponses.push(response);
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  const fingerprint = async () => (await pool.query<{ digest: string }>(
    "SELECT md5(string_agg(to_jsonb(activity)::text, '' ORDER BY id)) AS digest FROM payroll_transactions activity WHERE individual_id=$1", [person],
  )).rows[0].digest;
  try {
    const seedStart = performance.now();
    await pool.query('INSERT INTO individuals(id,display_name,normalized_name) VALUES($1,$2,$3)', [person, personName, `report-${person}`]);
    await pool.query('INSERT INTO employees(id,display_name,normalized_name) VALUES($1,$2,$3)', [employee, workerName, `report-${employee}`]);
    await pool.query("INSERT INTO programs(id,code,name,service_category,payment_recipient,required_auth_type) VALUES($1,$2,$3,'direct_service','excellent_staffing','hours')", [program, `REPORT_${program.replaceAll('-', '')}`, `Report program ${tag}`]);
    await pool.query(`INSERT INTO payroll_transactions
      (id,individual_id,employee_id,program_id,check_number,check_date,period_begin,period_end,
       source_row_number,imported_hours,imported_rate,imported_amount,calculated_internal_amount,
       internal_rate_applied,agency_rate_applied,payment_recipient,transaction_fingerprint)
      SELECT entry.id,$2,$3,$4,$5 || lpad(entry.position::text,5,'0'),DATE '2026-09-04',DATE '2026-09-01',DATE '2026-09-03',
       entry.position::int,1,100,100,60,60,100,'excellent_staffing','report-journey-' || entry.id::text
      FROM unnest($1::uuid[]) WITH ORDINALITY AS entry(id,position)`, [ids, person, employee, program, `REPORT-${tag}-`]);
    measurements.seedMs = Math.round(performance.now() - seedStart);
    const originalFingerprint = await fingerprint();

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/signin');
    await page.getByLabel('Email address').fill(ADMIN_EMAIL);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL(url => url.pathname === '/dashboard');

    const catalogStart = performance.now();
    await page.goto('/reports');
    await expect(page.locator('#main').getByRole('heading', { level: 1, name: 'Reports', exact: true })).toBeVisible();
    measurements.catalogReadyMs = Math.round(performance.now() - catalogStart);
    const reportStart = performance.now();
    await page.locator('#main a[href="/reports/transactions"]').click();
    await page.waitForURL(url => url.pathname === '/reports/transactions');
    const main = page.locator('#main');
    await expect(main.getByRole('heading', { level: 1, name: 'Transactions', exact: true })).toBeVisible();
    const table = page.locator('#report-table-transactions');
    await expect(table.locator('tbody > tr')).toHaveCount(50);
    measurements.catalogClickToReportReadyMs = Math.round(performance.now() - reportStart);
    measurements.initialRenderedRows = await table.locator('tbody > tr').count();
    await expect(main.locator('[role="alert"]')).toHaveCount(0);

    // This normal report filter is a unique name owned by this test. All later
    // screen/export assertions concern exactly these records, never shared data.
    const filterStart = performance.now();
    await page.getByLabel('Individual', { exact: true }).fill(personName);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/reports/transactions' && url.searchParams.get('individual') === personName);
    const report = main.getByRole('region', { name: 'Transactions', exact: true });
    const pages = report.getByRole('navigation', { name: 'Report pages' });
    await expect(pages.getByRole('status')).toContainText('of 2,000 matching rows');
    await expect(table.locator('tbody > tr')).toHaveCount(50);
    await expect(report.getByText('$200,000.00', { exact: true })).toBeVisible();
    await expect(report.getByText('$120,000.00', { exact: true })).toBeVisible();
    await expect(report.getByText('$80,000.00', { exact: true })).toBeVisible();
    measurements.individualFilterReadyMs = Math.round(performance.now() - filterStart);
    const sourceIds = async () => (await table.locator('tbody a[href^="/transactions?transactionId="]').evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href)))
      .map(href => new URL(href).searchParams.get('transactionId')!);
    const firstPage = await sourceIds();
    expect(firstPage).toHaveLength(50);
    const secondPageStart = performance.now();
    await pages.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(pages.getByText('Page 2 of 40', { exact: true })).toBeVisible();
    const secondPage = await sourceIds();
    expect(secondPage).toHaveLength(50);
    expect(secondPage.some(id => firstPage.includes(id))).toBe(false);
    expect(secondPage.every(id => ids.includes(id))).toBe(true);
    measurements.nextPageReadyMs = Math.round(performance.now() - secondPageStart);

    const offFirstPageIndex = ids.findIndex(id => !firstPage.includes(id));
    const searchStart = performance.now();
    await report.getByRole('searchbox', { name: 'Search', exact: true }).fill(check(offFirstPageIndex));
    await expect(table.locator('tbody > tr')).toHaveCount(1);
    expect(await sourceIds()).toEqual([ids[offFirstPageIndex]]);
    await expect(pages.getByText('Page 1 of 1', { exact: true })).toBeVisible();
    measurements.offPageSearchReadyMs = Math.round(performance.now() - searchStart);
    await report.getByRole('searchbox', { name: 'Search', exact: true }).fill('');
    await expect(pages.getByText('Page 1 of 40', { exact: true })).toBeVisible();
    await pages.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(pages.getByText('Page 2 of 40', { exact: true })).toBeVisible();

    // Download from page two to prove that the displayed slice is not used as
    // the export collection. This is the actual normal CSV button/download.
    const exportStart = performance.now();
    const pendingDownload = page.waitForEvent('download');
    await report.getByRole('button', { name: 'Export CSV', exact: true }).click();
    const download = await pendingDownload;
    expect(await download.failure()).toBeNull();
    const stream = await download.createReadStream();
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    measurements.csvDownloadMs = Math.round(performance.now() - exportStart);
    measurements.csvBytes = bytes.length;
    const workbook = new ExcelJS.Workbook();
    await workbook.csv.read(Readable.from([bytes]), { map: (value: string) => value });
    const sheet = workbook.worksheets[0]!;
    const headers = Array.from({ length: sheet.columnCount }, (_, index) => sheet.getRow(1).getCell(index + 1).text.replace(/^\uFEFF/, ''));
    const exported = Array.from({ length: sheet.rowCount - 1 }, (_, index) => Object.fromEntries(headers.map((header, column) => [header, sheet.getRow(index + 2).getCell(column + 1).text])));
    expect(exported).toHaveLength(ids.length);
    expect(exported.every(row => row.Individual === personName && row.Employee === workerName)).toBe(true);
    const exportedIds = exported.map(row => new URL(row['Ledger source'], 'http://localhost').searchParams.get('transactionId'));
    expect(exportedIds.slice().sort()).toEqual(ids.slice().sort());
    const sum = (key: string) => exported.reduce((total, row) => total.plus(row[key]), new Decimal(0)).toFixed(2);
    expect(sum('Funder billed')).toBe('200000.00');
    expect(sum('Employee base')).toBe('120000.00');
    expect(sum('Agency spread')).toBe('80000.00');
    expect(sum('Hours')).toBe('2000.00');
    expect(await fingerprint()).toBe(originalFingerprint);
    await expect(report.getByRole('button', { name: 'Export CSV', exact: true })).toBeEnabled();
    await page.evaluate(async () => { await document.fonts.ready; });
    await testInfo.attach('transactions-report-loaded-page-two', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    measurements.finalRenderedRows = await table.locator('tbody > tr').count();
    measurements.matchingRows = ids.length;
    measurements.exportedRows = exported.length;
    measurements.distinctExportedSourceIds = new Set(exportedIds).size;
    measurements.funderBilled = sum('Funder billed');
    measurements.employeeBase = sum('Employee base');
    measurements.agencySpread = sum('Agency spread');
    measurements.sourceUnchanged = true;
    expect(pageErrors).toEqual([]);
    measurements.verified = true;
  } finally {
    measurements.pageErrors = pageErrors;
    measurements.responses = reportResponses.map(response => ({ url: response.url(), status: response.status(), timing: response.request().timing() }));
    await testInfo.attach('transactions-report-journey-measurements', { body: Buffer.from(JSON.stringify(measurements, null, 2)), contentType: 'application/json' });
    await pool.query('DELETE FROM payroll_transactions WHERE id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM individuals WHERE id=$1', [person]);
    await pool.query('DELETE FROM employees WHERE id=$1', [employee]);
    await pool.query('DELETE FROM programs WHERE id=$1', [program]);
    await pool.end();
  }
});
