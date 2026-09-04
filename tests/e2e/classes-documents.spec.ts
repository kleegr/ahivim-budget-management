import { expect, test, type Browser, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import {
  BASE_URL,
  E2E_CLASS_BUDGET_LABEL,
  E2E_CLASS_DRAFT_INVOICE,
  E2E_CLASS_ISSUED_INVOICE,
  E2E_CLASS_MONTH,
  REPRESENTATIVE_ACCOUNTS,
  passwordFor,
  type RepresentativeAccount,
} from "./fixtures";

const classBilling = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "class_billing")!;
const budgetPlanner = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "budget_planner")!;

async function signIn(page: Page, account: RepresentativeAccount): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password").fill(passwordFor(account));
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.pathname === account.expectedPath, { timeout: 20_000 });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    bodyClient: document.body.clientWidth,
    bodyScroll: document.body.scrollWidth,
    rootClient: document.documentElement.clientWidth,
    rootScroll: document.documentElement.scrollWidth,
  }));
  expect(widths.bodyScroll, "body horizontal overflow").toBeLessThanOrEqual(widths.bodyClient + 1);
  expect(widths.rootScroll, "document horizontal overflow").toBeLessThanOrEqual(widths.rootClient + 1);
}

async function exerciseClassAndDocumentFlow(
  browser: Browser,
  viewport: { name: string; width: number; height: number },
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
    await signIn(page, classBilling);
    const response = await page.goto(`/classes?month=${E2E_CLASS_MONTH}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("#main").getByRole("heading", { level: 1, name: "Classes" })).toBeVisible();
    const records = viewport.width < 1024 ? page.locator("article") : page.getByRole("row");
    await expect(records.filter({ hasText: E2E_CLASS_BUDGET_LABEL }).first()).toBeVisible();
    await expect(records.filter({ hasText: E2E_CLASS_DRAFT_INVOICE }).first()).toBeVisible();
    await expect(records.filter({ hasText: E2E_CLASS_ISSUED_INVOICE }).first()).toBeVisible();
    await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    const previewLink = page.getByRole("link", { name: "Preview draft invoice PDF" }).first();
    const previewHref = await previewLink.getAttribute("href");
    expect(previewHref).toBeTruthy();
    const previewResponse = await page.request.get(previewHref!);
    expect(previewResponse.status()).toBe(200);
    expect(previewResponse.headers()["content-type"]).toContain("application/pdf");
    expect(previewResponse.headers()["content-disposition"]).toContain("inline");
    const draftPdf = await PDFDocument.load(await previewResponse.body());
    expect(draftPdf.getPageCount()).toBe(1);
    expect(draftPdf.getTitle()).toBe(`DRAFT - Invoice ${E2E_CLASS_DRAFT_INVOICE}`);

    const issuedDownloadLink = page.getByRole("link", { name: "Download invoice PDF" }).first();
    const issuedDownloadHref = await issuedDownloadLink.getAttribute("href");
    expect(issuedDownloadHref).toBeTruthy();
    const issuedResponse = await page.request.get(issuedDownloadHref!);
    expect(issuedResponse.status()).toBe(200);
    expect(issuedResponse.headers()["content-disposition"]).toContain("attachment");
    const issuedPdf = await PDFDocument.load(await issuedResponse.body());
    expect(issuedPdf.getPageCount()).toBe(1);
    expect(issuedPdf.getTitle()).toBe(`Invoice ${E2E_CLASS_ISSUED_INVOICE}`);

    await page.getByRole("link", { name: "Edit or save invoice PDF in Documents" }).first().click();
    await page.waitForURL((url) => url.pathname === "/documents/pdf-editor", { timeout: 20_000 });
    await expect(page.getByText("Not saved to library", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Save to library" })).toBeVisible();
    await expect(page.getByLabel("Export mode")).toHaveValue("standard");
    await page.getByRole("button", { name: "Replace visible text" }).click();
    await expect(page.getByText("Replacement paints a background cover and a new text layer. It does not reflow the source PDF text.", { exact: true })).toBeVisible();
    await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await page.goto("/documents");
    await expect(page.locator("#main").getByRole("heading", { level: 1, name: "Document library" })).toBeVisible();
    await expect(page.getByText("Your document library is ready", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload PDF" }).first()).toBeVisible();
    await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    expect(browserErrors, `${viewport.name} Classes/Documents browser errors`).toEqual([]);
  } finally {
    await context.close();
  }
}

for (const viewport of [
  { name: "desktop", width: 1365, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`class billing opens seeded invoices and the truthful PDF editor at ${viewport.name} size`, async ({ browser }) => {
    await exerciseClassAndDocumentFlow(browser, viewport);
  });
}

test("planning-only access cannot enter Classes, Documents, or their APIs", async ({ page }) => {
  await signIn(page, budgetPlanner);

  expect((await page.request.get("/api/classes/invoices")).status()).toBe(403);
  expect((await page.request.get("/api/documents")).status()).toBe(403);
  expect((await page.request.get("/api/documents/00000000-0000-4000-8000-000000000001")).status()).toBe(404);

  await page.goto(`/classes?month=${E2E_CLASS_MONTH}`);
  await page.waitForURL((url) => url.pathname === "/home" && url.searchParams.get("denied") === "1");
  await expect(page.getByText(E2E_CLASS_ISSUED_INVOICE, { exact: true })).toHaveCount(0);

  await page.goto("/documents");
  await page.waitForURL((url) => url.pathname === "/home" && url.searchParams.get("denied") === "1");
  await expect(page.getByRole("heading", { level: 1, name: "Document library" })).toHaveCount(0);
});
