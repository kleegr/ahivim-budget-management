import { expect, test, type Download, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { Pool } from "pg";
import { agencyDate } from "../../src/lib/business/agency-time";
import { cacheControlDirectives } from "../support/cache-control";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  DIRECT_CHECK_NUMBER,
  DIRECT_TRANSACTION_ONE_ID,
  EXPECTED_DISPOSABLE_DB_HOST,
  RESET_CONFIRMATION,
  TEST_DB_URL,
  assertSafeE2eDatabaseReset,
} from "./fixtures";

const MONTH = "2026-09";
const REPORT_PATH = `/reports/agency-financials?month=${MONTH}`;
const SOURCE_PATH = `/transactions?transactionId=${DIRECT_TRANSACTION_ONE_ID}`;
const INCOMPLETE_STATUS = "Incomplete - missing actuals or expenses are excluded";

async function signInAsOwner(page: Page): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 20_000 });
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(await download.failure()).toBeNull();
  return Buffer.concat(chunks);
}

async function verifyIncompleteHome(page: Page, pool: Pool): Promise<void> {
  assertSafeE2eDatabaseReset({
    connectionString: TEST_DB_URL,
    expectedHost: EXPECTED_DISPOSABLE_DB_HOST,
    confirmation: RESET_CONFIRMATION,
  });
  const original = await pool.query<{ period_begin: string | null; period_end: string | null }>(
    `SELECT period_begin::text, period_end::text FROM payroll_transactions
      WHERE id = $1 AND transaction_fingerprint = 'e2e-direct-row-1' AND payroll_check_id IS NULL`,
    [DIRECT_TRANSACTION_ONE_ID],
  );
  expect(original.rows).toHaveLength(1);
  const saved = original.rows[0]!;
  const today = agencyDate();
  let shifted = false;
  try {
    // Home always uses the current agency month. Move only this detached
    // synthetic service period, then restore it before dated report assertions.
    const updated = await pool.query(
      `UPDATE payroll_transactions SET period_begin = $2::date, period_end = $2::date
        WHERE id = $1 AND transaction_fingerprint = 'e2e-direct-row-1' AND payroll_check_id IS NULL`,
      [DIRECT_TRANSACTION_ONE_ID, today],
    );
    expect(updated.rowCount).toBe(1);
    shifted = true;
    await signInAsOwner(page);
    const homeMoney = page.getByRole("region", { name: "Money", exact: true });
    await expect(homeMoney.getByText("Agency result (incomplete)", { exact: true })).toBeVisible();
    await expect(homeMoney.getByText("Some amounts are missing or need review. This result is incomplete.", { exact: false })).toBeVisible();
    await expect(homeMoney.getByRole("link", { name: "Review source details", exact: true })).toHaveAttribute(
      "href", `/reports/agency-financials?month=${today.slice(0, 7)}`,
    );
    await page.getByText("Activity, budgets, and setup detail", { exact: true }).click();
    const moneyReview = page.getByRole("region", { name: "Needs attention", exact: true })
      .getByRole("link", { name: /Money & checks/ });
    await expect(moneyReview).toContainText("Current balances are unavailable until refreshed.");
    await expect(moneyReview).toHaveAttribute("href", "/masser");
    await expect(page.getByText("Verified employee give-back obligations with a remaining balance.", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("owner-home-incomplete.png"), fullPage: true });
  } finally {
    if (shifted) {
      const restored = await pool.query(
        `UPDATE payroll_transactions SET period_begin = $2::date, period_end = $3::date
          WHERE id = $1 AND transaction_fingerprint = 'e2e-direct-row-1'
            AND period_begin = $4::date AND period_end = $4::date`,
        [DIRECT_TRANSACTION_ONE_ID, saved.period_begin, saved.period_end, today],
      );
      expect(restored.rowCount).toBe(1);
      const restoredDates = await pool.query(
        "SELECT period_begin::text, period_end::text FROM payroll_transactions WHERE id = $1",
        [DIRECT_TRANSACTION_ONE_ID],
      );
      expect(restoredDates.rows).toEqual([saved]);
    }
  }
}

async function verifyIncompleteReport(page: Page, pool: Pool): Promise<void> {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await verifyIncompleteHome(page, pool);
  const navigation = await page.goto(REPORT_PATH);
  expect(navigation?.status()).toBe(200);
  const main = page.locator("#main");
  await expect(main.getByRole("heading", { level: 1, name: /^Agency financials$/i })).toBeVisible();
  await expect(main.getByText("Agency result (incomplete)", { exact: true })).toBeVisible();
  await expect(main.getByText("Missing actuals or expenses are excluded. Resolve the items below before relying on this result.", { exact: true })).toBeVisible();
  await expect(main.getByText("All included records are fully configured", { exact: true })).toHaveCount(0);
  // Missing verification never removes the recorded transaction's income.
  await expect(main.getByText("Actual income", { exact: true }).locator("..")).toContainText("$500.00");
  const reviewLink = main.getByRole("link", { name: "1 direct-pay transactions need check expense review for this month", exact: true });
  await expect(reviewLink).toHaveAttribute("href", SOURCE_PATH);
  await page.screenshot({ path: test.info().outputPath("owner-incomplete-report.png"), fullPage: true });

  for (const format of ["csv", "xlsx"] as const) {
    const downloadPromise = page.waitForEvent("download");
    await main.getByRole("link", { name: format === "csv" ? "CSV" : "Excel", exact: true }).click();
    const download = await downloadPromise;
    expect(download.url()).toBe(new URL(`/api/agency-financials/export?format=${format}&month=${MONTH}`, page.url()).href);
    // Browser-managed anchor downloads do not reliably emit page response
    // events. Check headers with the same authenticated session, then parse
    // the actual clicked download below as the exported content evidence.
    const response = await page.request.get(download.url());
    expect(response.status()).toBe(200);
    const cacheDirectives = cacheControlDirectives(response.headers()["cache-control"]);
    expect(cacheDirectives).toEqual(expect.arrayContaining(["private", "no-store"]));
    expect(cacheDirectives).not.toContain("public");
    expect(download.suggestedFilename()).toBe(`agency-financials-${MONTH}.${format}`);
    const bytes = await downloadBytes(download);
    if (format === "csv") {
      const csv = bytes.toString("utf8");
      expect(csv).toContain(INCOMPLETE_STATUS);
      expect(csv).toContain("Result,Agency result (incomplete),");
      expect(csv).toContain(`${DIRECT_TRANSACTION_ONE_ID},${SOURCE_PATH},No - review required,No - review required,`);
      expect(csv).toContain("Direct-pay transactions without verified check expenses in this month,1");
    } else {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      expect(workbook.getWorksheet("Report period")?.getCell("D2").value).toBe(INCOMPLETE_STATUS);
      const actuals = workbook.getWorksheet("Transaction actuals");
      expect(actuals).toBeDefined();
      const rows = actuals!.getRows(2, actuals!.rowCount - 1) ?? [];
      const sourceRows = rows.filter((row) => row.getCell(1).value === DIRECT_TRANSACTION_ONE_ID);
      expect(sourceRows).toHaveLength(1);
      expect(sourceRows[0]!.getCell(2).value).toBe(SOURCE_PATH);
      expect(sourceRows[0]!.getCell(3).value).toBe("No - review required");
      expect(sourceRows[0]!.getCell(4).value).toBe("No - review required");
      const summaryRows = workbook.getWorksheet("Summary totals")!.getColumn(2).values;
      expect(summaryRows).toContain("Agency result (incomplete)");
    }
  }

  await reviewLink.click();
  await page.waitForURL((url) => url.pathname === "/transactions"
    && url.searchParams.get("transactionId") === DIRECT_TRANSACTION_ONE_ID);
  await expect(main.getByRole("heading", { level: 1, name: "Transactions", exact: true })).toBeVisible();
  await expect(main.getByText(`Selected transaction · check ${DIRECT_CHECK_NUMBER}`, { exact: true })).toBeVisible();
  const transactionRows = main.getByRole("tabpanel").locator("tbody > tr");
  await expect(transactionRows).toHaveCount(1);
  await transactionRows.getByRole("button", { name: /^Open transaction details/ }).click();
  const details = page.getByRole("dialog", { name: "Linked Individual", exact: true });
  await expect(details.getByText("Check status", { exact: true }).locator("..")).toContainText("Not linked");
  await expect(details.getByText("Funder billed", { exact: true }).locator("..")).toContainText("$125.00");
  await expect(details.getByText("Source evidence", { exact: true })).toBeVisible();
  await expect(details.getByText("Original activity record · row 101", { exact: true })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
}

test.describe.serial("Owner financial completeness from exact source evidence", () => {
  let pool: Pool | undefined;
  let originalCheckId: string | undefined;

  test.beforeAll(async () => {
    // This fixture mutation is only allowed under the same disposable-database
    // interlock as the seed. No settlement refresh or money event is performed.
    assertSafeE2eDatabaseReset({
      connectionString: TEST_DB_URL,
      expectedHost: EXPECTED_DISPOSABLE_DB_HOST,
      confirmation: RESET_CONFIRMATION,
    });
    pool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    const source = await pool.query<{ payroll_check_id: string }>(
      `SELECT t.payroll_check_id FROM payroll_transactions t
         JOIN employee_payroll_checks pc ON pc.id = t.payroll_check_id
          AND pc.employee_id = t.employee_id AND pc.verification_status = 'verified'
        WHERE t.id = $1 AND t.transaction_fingerprint = 'e2e-direct-row-1'`,
      [DIRECT_TRANSACTION_ONE_ID],
    );
    expect(source.rows).toHaveLength(1);
    originalCheckId = source.rows[0]!.payroll_check_id;
    const detached = await pool.query(
      `UPDATE payroll_transactions SET payroll_check_id = NULL
        WHERE id = $1 AND payroll_check_id = $2`,
      [DIRECT_TRANSACTION_ONE_ID, originalCheckId],
    );
    expect(detached.rowCount).toBe(1);
  });

  test.afterAll(async () => {
    try {
      if (pool && originalCheckId) {
        const restored = await pool.query(
          `UPDATE payroll_transactions SET payroll_check_id = $2
            WHERE id = $1 AND payroll_check_id IS NULL`,
          [DIRECT_TRANSACTION_ONE_ID, originalCheckId],
        );
        expect(restored.rowCount).toBe(1);
      }
    } finally {
      await pool?.end();
    }
  });

  for (const viewport of [
    { label: "desktop", width: 1440, height: 1000 },
    { label: "mobile", width: 390, height: 844 },
  ]) {
    test(`owner sees incomplete actuals, exact source, and honest exports on ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await verifyIncompleteReport(page, pool!);
    });
  }
});
