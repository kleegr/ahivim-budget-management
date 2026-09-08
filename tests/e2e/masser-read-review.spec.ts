import { expect, test, type Download, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { Pool } from "pg";
import { cacheControlDirectives } from "../support/cache-control";
import {
  ADMIN_EMAIL, ADMIN_PASSWORD, EXPECTED_DISPOSABLE_DB_HOST, LINKED_INDIVIDUAL_ID,
  RESET_CONFIRMATION, TEST_DB_URL, UNLINKED_INDIVIDUAL_ID, assertSafeE2eDatabaseReset,
} from "./fixtures";
import {
  MASSER_REVIEW_CHECK_COUNT, MASSER_REVIEW_COLLECTOR_EMAIL, MASSER_REVIEW_COLLECTOR_PASSWORD,
  MASSER_REVIEW_EMPLOYEE_ID, MASSER_REVIEW_EMPLOYEE_NAME, MASSER_REVIEW_OBLIGATION_ID,
} from "./masser-read-review-fixtures";

const MONTH = "2026-09";
const STATEMENT = `/masser/individuals/${LINKED_INDIVIDUAL_ID}?month=${MONTH}`;
const REPORT = `/reports/individual-put-away?month=${MONTH}&individual=Linked%20Individual`;
const REVIEW_STATUS = "Source review required; held balances excluded";

async function signIn(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(url => ["/dashboard", "/home"].includes(url.pathname));
}

async function downloadBytes(download: Download) {
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(await download.failure()).toBeNull();
  return Buffer.concat(chunks);
}

test.describe.serial("Masser retained source-review balances across actual routes", () => {
  let pool: Pool;
  test.beforeAll(() => {
    assertSafeE2eDatabaseReset({ connectionString: TEST_DB_URL,
      expectedHost: EXPECTED_DISPOSABLE_DB_HOST, confirmation: RESET_CONFIRMATION });
    // This spec only reads PostgreSQL. The guarded seed owns synthetic writes;
    // the real authenticated refresh below is the only financial workflow call.
    pool = new Pool({ connectionString: TEST_DB_URL, max: 1, options: "-c default_transaction_read_only=on" });
  });
  test.afterAll(async () => { await pool?.end(); });

  async function immutableFacts() {
    return (await pool.query(`SELECT
      (SELECT to_jsonb(o)::text FROM settlement_obligations o WHERE id = $1) AS obligation,
      (SELECT count(*)::int FROM settlement_events) AS event_count,
      (SELECT md5(COALESCE(string_agg(to_jsonb(e)::text, '' ORDER BY e.id), '')) FROM settlement_events e) AS event_hash,
      (SELECT md5(string_agg(to_jsonb(c)::text, '' ORDER BY c.id)) FROM employee_payroll_checks c
        WHERE source_ref = 'disposable_e2e_review') AS checks_hash`, [MASSER_REVIEW_OBLIGATION_ID])).rows[0];
  }

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    test(`owner keeps held balances out of actions, statements and exports at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const runtimeErrors: string[] = [];
      page.on("pageerror", error => runtimeErrors.push(error.message));
      const before = await immutableFacts();
      expect(before.obligation).toContain('"original_amount": 2100.0000');
      await signIn(page);
      await page.goto("/settlements?queue=all");
      const refreshResponse = page.waitForResponse(response => response.url().endsWith("/api/settlements/refresh")
        && response.request().method() === "POST");
      await page.getByRole("button", { name: "Refresh items", exact: true }).click();
      const refreshed = await refreshResponse;
      expect(refreshed.status()).toBe(200);
      expect(await refreshed.json()).toMatchObject({ ok: true, data: { created: 0, updated: 0, adjusted: 0, voided: 0 } });

      expect((await page.goto(`/masser?month=${MONTH}`))?.status()).toBe(200);
      const main = page.locator("#main");
      const row = main.getByRole("row").filter({ hasText: "Linked Individual" });
      await expect(row).toContainText("$260.00");
      await expect(row).toContainText("Held balances excluded");
      await expect(row.getByRole("cell").nth(3)).toContainText("Unavailable");
      await expect(row.getByRole("cell").nth(3)).not.toContainText("$0.00");
      await expect(row.getByText("Ready", { exact: true })).toHaveCount(0);
      await expect(row.getByRole("link", { name: "Record set-aside", exact: true })).toHaveCount(0);
      await expect(row.getByRole("link", { name: "Source review required", exact: true }))
        .toHaveAttribute("href", `/settlements?individualId=${LINKED_INDIVIDUAL_ID}`);
      await expect(row.getByRole("link", { name: "Review Financial Setup", exact: true }))
        .toHaveAttribute("href", `/individuals/${LINKED_INDIVIDUAL_ID}?view=financial`);
      const statementLink = row.getByRole("link", { name: "View statement", exact: true });
      await expect(statementLink).toHaveAttribute("href", STATEMENT);
      await page.screenshot({ path: test.info().outputPath("masser-held-overview.png"), fullPage: true });
      await statementLink.click();
      await expect(page).toHaveURL(new URL(STATEMENT, page.url()).href);
      await expect(main.getByRole("heading", { level: 1, name: "Linked Individual", exact: true })).toBeVisible();
      await expect(main.getByText("Source review required", { exact: true })).toBeVisible();
      await expect(main.getByText("Approved monthly plan", { exact: true }).locator("..")).toContainText("$260.00");
      await expect(main.getByText("Remaining in plan period", { exact: true }).locator("..")).toContainText("Unavailable");
      await expect(main.getByText("Recorded over plan period", { exact: true }).locator("..")).toContainText("$0.00");
      await expect(main.getByText("Credit", { exact: true }).locator("..")).toContainText("Unavailable");
      await page.screenshot({ path: test.info().outputPath("masser-held-statement.png"), fullPage: true });

      expect((await page.goto(REPORT))?.status()).toBe(200);
      const reportRow = main.getByRole("row").filter({ hasText: "Linked Individual" });
      await expect(reportRow).toContainText(REVIEW_STATUS);
      await expect(reportRow).toContainText("$260.00");
      await expect(reportRow.getByRole("link", { name: "View statement", exact: true })).toHaveAttribute("href", STATEMENT);
      for (const format of ["csv", "xlsx"] as const) {
        const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/api/grid/export"
          && response.request().method() === "POST" && response.request().postDataJSON().format === format);
        const downloadPromise = page.waitForEvent("download");
        await main.getByRole("button", { name: format === "csv" ? "Export CSV" : "Excel", exact: true }).click();
        const [response, download] = await Promise.all([responsePromise, downloadPromise]);
        expect(response.status()).toBe(200);
        expect(cacheControlDirectives(response.headers()["cache-control"])).toContain("no-store");
        expect(download.suggestedFilename()).toMatch(new RegExp(`^individual-put-away-\\d{4}-\\d{2}-\\d{2}\\.${format}$`));
        const bytes = await downloadBytes(download);
        if (format === "csv") {
          const csv = bytes.toString("utf8");
          expect(csv).toContain("Plans on source review,Balance review");
          expect(csv).toContain("Linked Individual,260.00,");
          expect(csv).toContain(`,1,${REVIEW_STATUS},`);
          expect(csv).toContain(LINKED_INDIVIDUAL_ID);
          expect(csv).not.toContain("No source holds");
        } else {
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
          const sheet = workbook.worksheets[0]!;
          const headers = sheet.getRow(1).values as string[];
          const rows = sheet.getRows(2, sheet.rowCount - 1)!;
          expect(rows).toHaveLength(1);
          const value = (header: string) => rows[0]!.getCell(headers.indexOf(header)).value;
          expect(value("Approved monthly plan")).toBe(260);
          expect(value("Verified remaining reserve subtotal")).toBeNull();
          expect(value("Plans on source review")).toBe(1);
          expect(value("Balance review")).toBe(REVIEW_STATUS);
          expect(value("Source statement")).toBe(LINKED_INDIVIDUAL_ID);
        }
      }
      await page.goto(`${REPORT}&status=complete`);
      await expect(main.getByText("No individual put-away records match this month and filter.", { exact: true })).toBeVisible();
      await expect(main.getByRole("row").filter({ hasText: "Linked Individual" })).toHaveCount(0);
      expect(await immutableFacts()).toEqual(before);
      expect(runtimeErrors).toEqual([]);
    });
  }

  test("a direct scoped collector sees all 688 pending checks without hidden records or owner profit", async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", error => runtimeErrors.push(error.message));
    const before = await immutableFacts();
    expect((await pool.query(`SELECT count(*)::int AS total FROM employee_payroll_checks
      WHERE employee_id = $1 AND verification_status = 'unverified'`, [MASSER_REVIEW_EMPLOYEE_ID])).rows[0]?.total)
      .toBe(MASSER_REVIEW_CHECK_COUNT);
    await signIn(page, MASSER_REVIEW_COLLECTOR_EMAIL, MASSER_REVIEW_COLLECTOR_PASSWORD);
    const response = await page.goto(`/masser?month=${MONTH}&view=checks`);
    expect(response?.status()).toBe(200);
    const main = page.locator("#main");
    await expect(main.getByText("688 payroll checks need confirmation.", { exact: false })).toBeVisible();
    await expect(main.getByText("Showing 100 of 688 payroll checks.", { exact: false })).toBeVisible();
    const rows = main.locator("#collections-panel-checks tbody > tr");
    await expect(rows).toHaveCount(100);
    await expect(rows.first()).toContainText(MASSER_REVIEW_EMPLOYEE_NAME);
    const html = await response!.text();
    expect(html).not.toContain("E2E-REVIEW-hidden-");
    expect(html).not.toContain("Unlinked Employee");
    expect(html).not.toContain("Agency result");
    await expect(main.getByRole("link", { name: /Agency financials/i })).toHaveCount(0);
    await page.goto(STATEMENT);
    await expect(main.getByText("Source review required", { exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: "Review Financial Setup", exact: true })).toHaveCount(0);
    // A streamed page can send its shell with 200 before notFound() resolves.
    // Check the actual denial and payload as well as the non-streaming API.
    const denied = await page.goto(`/masser/individuals/${UNLINKED_INDIVIDUAL_ID}?month=${MONTH}`);
    expect([200, 404]).toContain(denied?.status());
    await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
    await expect(page.getByText("This page could not be found.", { exact: true })).toBeVisible();
    const deniedHtml = await denied!.text();
    expect(deniedHtml).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
    for (const privateValue of ["Unlinked Individual", "E2E-PRIVATE", "Remaining in plan period", "Approved monthly plan"]) {
      expect(deniedHtml).not.toContain(privateValue);
    }
    const deniedApi = await page.request.get(`/api/individuals/${UNLINKED_INDIVIDUAL_ID}`);
    expect(deniedApi.status()).toBe(404);
    expect(await deniedApi.text()).not.toContain("Unlinked Individual");
    expect(await immutableFacts()).toEqual(before);
    expect(runtimeErrors).toEqual([]);
  });
});
