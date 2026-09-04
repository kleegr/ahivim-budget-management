import { test, expect, type Browser, type Page } from "@playwright/test";
import {
  BASE_URL,
  REPRESENTATIVE_ACCOUNTS,
  UNLINKED_EMPLOYEE_ID,
  UNLINKED_INDIVIDUAL_ID,
  passwordFor,
  type RepresentativeAccount,
} from "./fixtures";

async function signIn(page: Page, account: RepresentativeAccount): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password").fill(passwordFor(account));
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.pathname === account.expectedPath, { timeout: 20_000 });
}

const FINANCIAL_FIELDS_FORBIDDEN = new Set<RepresentativeAccount["preset"]>([
  "budget_planner",
  "staffing_manager",
  "class_billing",
  "individual_parent",
  "employee",
  "agency",
  "agency_scheduler",
  "agency_staffing_manager",
  "custom_access",
]);

async function expectContainedPage(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    bodyClient: document.body.clientWidth,
    bodyScroll: document.body.scrollWidth,
    rootClient: document.documentElement.clientWidth,
    rootScroll: document.documentElement.scrollWidth,
  }));
  expect(widths.bodyScroll, "body horizontal overflow").toBeLessThanOrEqual(widths.bodyClient + 1);
  expect(widths.rootScroll, "document horizontal overflow").toBeLessThanOrEqual(widths.rootClient + 1);
}

async function verifyDirectLogin(
  browser: Browser,
  account: RepresentativeAccount,
  viewport: { name: "desktop" | "phone"; width: number; height: number },
): Promise<void> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));

  try {
    await signIn(page, account);
    await expect(page.locator("#main").getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expectContainedPage(page);

    let navigation = page.getByRole("navigation", { name: "Primary" });
    if (viewport.name === "phone") {
      await page.getByRole("button", { name: "Open navigation" }).click();
      const sidebar = page.getByRole("dialog", { name: "Main navigation" });
      await expect(sidebar).toBeVisible();
      navigation = sidebar.getByRole("navigation", { name: "Primary" });
    }
    const canonicalWorkspace = account.external ? "My portal" : "Home";
    await expect(navigation.getByRole("link", { name: canonicalWorkspace, exact: true }).first()).toBeVisible();

    if (account.preset !== "owner") {
      await expect(navigation.locator('a[href="/settings/role-preview"]')).toHaveCount(0);
      await expect(navigation.locator('a[href="/reports/agency-financials"]')).toHaveCount(0);
      await expect(navigation.getByText("Users & settings", { exact: true })).toHaveCount(0);
    }
    if (FINANCIAL_FIELDS_FORBIDDEN.has(account.preset)) {
      const main = page.locator("#main");
      for (const field of ["Employee base", "Agency spread", "Net payroll", "Withholding", "Taxes"]) {
        await expect(main.getByText(field, { exact: true })).toHaveCount(0);
      }
    }

    await expectContainedPage(page);
    expect(browserErrors, `${account.preset} ${viewport.name} browser errors`).toEqual([]);
  } finally {
    await context.close();
  }
}

test.describe("representative direct logins", () => {
  for (const account of REPRESENTATIVE_ACCOUNTS) {
    test(`${account.preset} reaches only its canonical landing at desktop and phone sizes`, async ({ browser }) => {
      await test.step("desktop", () => verifyDirectLogin(browser, account, {
        name: "desktop",
        width: 1365,
        height: 900,
      }));
      await test.step("phone", () => verifyDirectLogin(browser, account, {
        name: "phone",
        width: 390,
        height: 844,
      }));
    });
  }
});

test("parent and employee URLs do not widen beyond their direct subject", async ({ browser }) => {
  const parentContext = await browser.newContext({ baseURL: BASE_URL });
  const parentPage = await parentContext.newPage();
  const parent = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "individual_parent")!;
  await signIn(parentPage, parent);
  await expect(parentPage.getByText("Linked Individual").first()).toBeVisible();
  await parentPage.goto(`/individuals/${UNLINKED_INDIVIDUAL_ID}`);
  await expect(parentPage.getByRole("heading", { level: 1, name: "404" })).toBeVisible();
  await expect(
    parentPage.getByRole("heading", { level: 2, name: "This page could not be found." }),
  ).toBeVisible();
  await expect(parentPage.getByText("Private Unlinked Individual")).toHaveCount(0);
  await parentContext.close();

  const employeeContext = await browser.newContext({ baseURL: BASE_URL });
  const employeePage = await employeeContext.newPage();
  const employee = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "employee")!;
  await signIn(employeePage, employee);
  await expect(employeePage.getByText("Linked Employee").first()).toBeVisible();
  await employeePage.goto(`/employees/${UNLINKED_EMPLOYEE_ID}`);
  await expect(employeePage.getByRole("heading", { level: 1, name: "404" })).toBeVisible();
  await expect(
    employeePage.getByRole("heading", { level: 2, name: "This page could not be found." }),
  ).toBeVisible();
  await expect(employeePage.getByText("Private Unlinked Employee")).toHaveCount(0);
  await employeeContext.close();
});

test("owner can preview a real portal account and return to the owner session", async ({ page }) => {
  const owner = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "owner")!;
  await signIn(page, owner);
  await page.goto("/settings/role-preview");

  const parentCard = page.locator("article").filter({
    has: page.getByRole("heading", { level: 2, name: "Individual or parent" }),
  });
  await parentCard.getByRole("button", { name: "Preview / Sign in as" }).click();
  await page.waitForURL((url) => url.pathname === "/portal");
  await expect(
    page.getByRole("status").filter({ hasText: "Viewing as E2E Parent" }),
  ).toContainText("Viewing as E2E Parent");
  await expect(page.getByRole("link", { name: /^Home$/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Return to owner portal" }).click();
  await page.waitForURL((url) => url.pathname === "/dashboard");
  await expect(page.getByText("Viewing as E2E Parent")).toHaveCount(0);
  await expect(page.locator("#main").getByRole("heading", { level: 1 }).first()).toBeVisible();
});
