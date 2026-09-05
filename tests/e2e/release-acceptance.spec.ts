import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  BASE_URL,
  CURRENT_BUDGET_LABEL,
  DIRECT_CHECK_NUMBER,
  HISTORICAL_BUDGET_LABEL,
  LINKED_EMPLOYEE_ID,
  LINKED_INDIVIDUAL_ID,
  PRIMARY_CALCULATION_ACCOUNT,
  REPRESENTATIVE_ACCOUNTS,
  SECONDARY_CALCULATION_ACCOUNT,
  passwordFor,
  type RepresentativeAccount,
} from "./fixtures";

const owner = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "owner")!;
const budgetPlanner = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "budget_planner")!;

async function signIn(page: Page, account: RepresentativeAccount = owner): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password").fill(passwordFor(account));
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.pathname === account.expectedPath, { timeout: 20_000 });
}

async function openReady(page: Page, path: string, heading: string | RegExp): Promise<Locator> {
  const response = await page.goto(path);
  expect(response, `no navigation response for ${path}`).not.toBeNull();
  expect(response!.status(), `HTTP status for ${path}`).toBe(200);
  const main = page.locator("#main");
  await expect(main.locator('[role="alert"]'), `error panel on ${path}`).toHaveCount(0);
  await expect(main.getByRole("heading", { level: 1, name: heading }).first()).toBeVisible();
  return main;
}

async function expectMetric(scope: Locator, label: string, value: string): Promise<void> {
  const metric = scope
    .getByText(label, { exact: true })
    .locator("..")
    .filter({ hasText: value })
    .first();
  await expect(metric).toBeVisible();
  await expect(metric).toContainText(value);
}

test("owner sees exact row totals and whole-check totals without counting repeated NET twice", async ({ page }) => {
  await signIn(page);
  const main = await openReady(page, "/transactions", /^Activity$/);

  await expectMetric(main, "Funder billed", "$350.00");
  await expectMetric(main, "Employee base", "$294.00");
  await expectMetric(main, "Agency spread", "$56.00");
  await expectMetric(main, "Hours", "14");
  await expect(main.getByText(DIRECT_CHECK_NUMBER, { exact: true }).first()).toBeVisible();

  await main.getByRole("button", { name: "More totals" }).click();
  await expectMetric(main, "Verified check gross", "$300.00");
  await expectMetric(main, "Verified check net", "$240.00");
  await expectMetric(main, "Verified withholding", "$60.00");
  await expectMetric(main, "Source net (per payment)", "$240.00");
  await expectMetric(main, "Recorded services", "3");
  await expectMetric(main, "# Checks", "2");

  await main.getByRole("tab", { name: /Payroll checks/ }).click();
  const checks = main.getByRole("tabpanel");
  await expectMetric(checks, "Checks", "2");
  await expectMetric(checks, "Funder billed", "$350.00");
  await expectMetric(checks, "Verified gross", "$300.00");
  await expectMetric(checks, "Verified net", "$240.00");
  await expectMetric(checks, "Withholding", "$60.00");
  const directCheck = checks.getByRole("row").filter({ hasText: `#${DIRECT_CHECK_NUMBER}` });
  await expect(directCheck).toContainText("$250.00");
  await expect(directCheck).toContainText("$240.00");
  await expect(directCheck.getByRole("link", { name: "Open 2 services" })).toBeVisible();
});

test("Budget Status and Up To Date preserve current math and historical authorization truth", async ({ page }) => {
  await signIn(page);
  const main = await openReady(page, "/individuals?sheet=up_to_date", /^People & budgets$/);
  await expect(main.getByRole("tab", { name: /Up To Date/ })).toHaveAttribute("aria-selected", "true");

  await expectMetric(main, "Current periods", "1");
  await expectMetric(main, "Billed", "14 h");
  await expectMetric(main, "Original", "100 h");
  await expectMetric(main, "What's Left", "86 h");
  await expectMetric(main, "After schedule", "84 h");

  const currentTable = main.getByRole("region", {
    name: "Current authorization balances by individual and program",
  });
  const currentRow = currentTable.getByRole("row").filter({ hasText: CURRENT_BUDGET_LABEL });
  await expect(currentRow).toContainText("Linked Individual");
  await expect(currentRow.getByText("14", { exact: true })).toHaveCount(2);
  await expect(currentRow.getByText("100", { exact: true })).toHaveCount(2);
  await expect(currentRow.getByText("86", { exact: true })).toHaveCount(2);

  await main.getByText("Historical authorization periods", { exact: false }).click();
  const historyTable = main.getByRole("region", {
    name: "Historical authorization balances by individual and program",
  });
  const historyRow = historyTable.getByRole("row").filter({ hasText: HISTORICAL_BUDGET_LABEL });
  await expect(historyRow).toContainText("Historical");
  await expect(historyRow.getByText("80", { exact: true })).toHaveCount(4);
});

test("Calculations and the two detail profiles expose real linked plan, activity, and schedule values", async ({ page }) => {
  await signIn(page);
  let main = await openReady(page, "/calculations", /^Financial setup$/);
  await expectMetric(main, "Approved final", "$260.00");
  await expect(main.getByText("2 monthly approved amounts", { exact: true })).toBeVisible();
  const primary = main.getByRole("row").filter({ hasText: PRIMARY_CALCULATION_ACCOUNT });
  const secondary = main.getByRole("row").filter({ hasText: SECONDARY_CALCULATION_ACCOUNT });
  await expect(primary).toContainText("Linked Individual");
  await expect(primary).toContainText("$175.00");
  await expect(secondary).toContainText("$85.00");

  main = await openReady(page, `/individuals/${LINKED_INDIVIDUAL_ID}`, "Linked Individual");
  await expect(main.getByText(/Used\s+14\s+of\s+100\s+hours/)).toBeVisible();
  await expect(main.getByText("86 h remaining now", { exact: false })).toBeVisible();
  await expect(main.getByText("2 h scheduled", { exact: true })).toBeVisible();
  await expect(main.getByText("84 h after schedule", { exact: true })).toBeVisible();
  await expect(main.getByText(/Core supports, Supplemental supports.*\$260\.00 total approved monthly/)).toBeVisible();

  await main.getByRole("tab", { name: "Activity & Schedule" }).click();
  await expect(main.getByText(/Oct 15, 2026/).first()).toBeVisible();
  const employeeLink = main.getByRole("link", { name: "Linked Employee", exact: true }).first();
  await expect(employeeLink).toBeVisible();
  await employeeLink.click();
  await page.waitForURL((url) => url.pathname === `/employees/${LINKED_EMPLOYEE_ID}`);

  main = page.locator("#main");
  await expect(main.locator('[role="alert"]')).toHaveCount(0);
  await expect(main.getByRole("heading", { level: 1, name: "Linked Employee" })).toBeVisible();
  await expectMetric(main, "Actual service", "14 h");
  await expectMetric(main, "Current assignments", "1");
  await expectMetric(main, "Upcoming schedule", "2 h");
  await main.getByRole("tab", { name: "Actual Activity" }).click();
  await expect(main.getByText(DIRECT_CHECK_NUMBER, { exact: true }).first()).toBeVisible();
  await expect(main.getByText("Recent actual transactions", { exact: true })).toBeVisible();
});

test("Owner Home, Masser, and Agency Financials reconcile to the same seeded facts", async ({ page }) => {
  await signIn(page);
  let main = await openReady(page, "/dashboard", /^Home$/);
  const transactionSection = main.locator('section[aria-labelledby="owner-transactions-heading"]');
  await expectMetric(transactionSection, "Funder billed", "$350.00");
  await expectMetric(transactionSection, "Employee base", "$294.00");
  await expectMetric(transactionSection, "Agency spread", "$56.00");
  await expectMetric(transactionSection, "Net payroll", "$240.00");
  const budgetSection = main.locator('section[aria-labelledby="owner-budgets-heading"]');
  await expectMetric(budgetSection, "Hours authorized", "100");
  await expectMetric(budgetSection, "Hours used", "14");
  await expectMetric(budgetSection, "Hours remaining", "86");
  const financialSection = main.locator('section[aria-labelledby="owner-financial-heading"]');
  await expectMetric(financialSection, "Current plans", "2");
  await expectMetric(financialSection, "Approved final", "$260.00");

  main = await openReady(page, "/masser?month=2026-09", "Money to collect, pay, and put away");
  await expectMetric(main, "Give-backs from checks", "$24.00");
  await expectMetric(main, "Employee balance", "$24.00");
  await expectMetric(main, "Approved monthly set-aside", "$260.00");
  const employeeRow = main.getByRole("row").filter({ hasText: "Linked Employee" });
  await expect(employeeRow).toContainText("$24.00");
  const individualRow = main.getByRole("row").filter({ hasText: "Linked Individual" });
  await expect(individualRow).toContainText("2 approved setups");
  await expect(individualRow).toContainText("$260.00");
  await expect(individualRow).toContainText("Ready");

  main = await openReady(page, "/reports/agency-financials?month=2026-09", /^Agency financials$/i);
  await expectMetric(main, "Actual income", "$500.00");
  await expect(main.getByText("All included records are fully configured", { exact: true })).toBeVisible();
  const bridge = main.getByRole("row").filter({ hasText: "All transactions with complete base facts" });
  await expect(bridge).toContainText("3");
  await expect(bridge).toContainText("$350.00");
  await expect(bridge).toContainText("$294.00");
  await expect(bridge).toContainText("$56.00");
  await main.getByRole("tab", { name: "Set-asides" }).click();
  const setAsideRow = main.getByRole("row").filter({ hasText: "Core supports" });
  await expect(setAsideRow).toContainText("Linked Individual");
  await expect(setAsideRow).toContainText("$175.00");
});

test("a planning-only role cannot open or infer private transaction values", async ({ page }) => {
  await signIn(page, budgetPlanner);
  await page.goto("/transactions");
  await page.waitForURL((url) => url.pathname === "/schedule");
  await expect(page.locator("#main").getByRole("heading", { level: 1, name: "Scheduling" })).toBeVisible();
  await expect(page.getByText(DIRECT_CHECK_NUMBER, { exact: true })).toHaveCount(0);
  await expect(page.getByText("$350.00", { exact: true })).toHaveCount(0);
});

test("Owner Activity table remains usable at a phone viewport", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard(?:\?|$)/, { timeout: 20_000 });
  await openReady(page, "/transactions", /^Activity$/);

  const table = page.getByRole("table").last();
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Pay to" })).toBeVisible();
  await expect(table.getByText(DIRECT_CHECK_NUMBER, { exact: true }).first()).toBeVisible();
  expect(await table.getByRole("row").count()).toBeGreaterThan(1);
  await context.close();
});
