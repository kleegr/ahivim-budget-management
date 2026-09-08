import { expect, test, type Download, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { Pool } from "pg";
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

async function verifyIncompleteReport(page: Page): Promise<void> {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await signInAsOwner(page);
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

  for (const format of ["csv", "xlsx"] as const) {
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/agency-financials/export"
        && url.searchParams.get("format") === format;
    });
    const downloadPromise = page.waitForEvent("download");
    await main.getByRole("link", { name: format === "csv" ? "CSV" : "Excel", exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    const download = await downloadPromise;
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
  await expect(main.getByRole("heading", { level: 1, name: "Activity", exact: true })).toBeVisible();
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
      await verifyIncompleteReport(page);
    });
  }
});
