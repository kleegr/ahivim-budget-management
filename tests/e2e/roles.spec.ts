import { test, expect, type Page } from "@playwright/test";
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

test.describe("representative direct logins", () => {
  for (const account of REPRESENTATIVE_ACCOUNTS) {
    test(`${account.preset} reaches only its canonical landing`, async ({ page }) => {
      await signIn(page, account);
      await expect(page.locator("#main").getByRole("heading", { level: 1 }).first()).toBeVisible();

      if (account.external) {
        await expect(page.getByRole("link", { name: /^Home$/ })).toHaveCount(0);
      }
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

test("an external portal remains usable in a phone-sized viewport", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const parent = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "individual_parent")!;
  await signIn(page, parent);

  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("dialog", { name: "Main navigation" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { name: "My portal" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: /^Home$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(navigation).toBeHidden();
  await context.close();
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
