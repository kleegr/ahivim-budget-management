import { expect, test, type Browser, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { pdfText } from "../support/pdf-text";
import {
  BASE_URL,
  E2E_CLASS_BUDGET_LABEL,
  E2E_CLASS_DRAFT_INVOICE,
  E2E_CLASS_ISSUED_INVOICE,
  E2E_CLASS_MONTH,
  LINKED_INDIVIDUAL_ID,
  REPRESENTATIVE_ACCOUNTS,
  passwordFor,
  type RepresentativeAccount,
} from "./fixtures";

const classBilling = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "class_billing")!;
const budgetPlanner = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "budget_planner")!;
const owner = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "owner")!;

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
    await expect(records.filter({ hasText: E2E_CLASS_ISSUED_INVOICE }).first().getByRole("button", { name: "Void invoice", exact: true })).toBeVisible();
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

for (const viewport of [
  { name: "desktop", width: 1365, height: 900, month: "2027-05" },
  { name: "phone", width: 390, height: 844, month: "2028-01" },
]) {
  test(`class allowance, draft previews, issue, separate receipt and void at ${viewport.name} size`, async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ baseURL: BASE_URL, viewport });
    const ownerContext = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    const ownerPage = await ownerContext.newPage();
    const invoiceNumber = `E2E-LIFECYCLE-${viewport.name}`;
    const label = `E2E lifecycle ${viewport.name} allowance`;
    try {
      await signIn(page, classBilling);
      await page.goto(`/classes?month=${viewport.month}`);
      await page.getByRole("button", { name: "Allowance", exact: true }).click();
      const allowance = page.getByRole("dialog");
      await allowance.getByRole("combobox", { name: "Individual", exact: true }).selectOption(LINKED_INDIVIDUAL_ID);
      await allowance.getByLabel("Label", { exact: true }).fill(label);
      await allowance.getByLabel("Starts", { exact: true }).fill(`${viewport.month}-01`);
      await allowance.getByLabel("Ends", { exact: true }).fill(`${viewport.month}-31`);
      await allowance.getByLabel("Authorized amount").fill("20000");
      const budgetResponse = page.waitForResponse((response) => response.url().endsWith("/api/classes/budgets") && response.request().method() === "POST");
      await allowance.getByRole("button", { name: "Save", exact: true }).click();
      const budgetResult = await budgetResponse;
      expect(budgetResult.status()).toBe(201);
      const budget = (await budgetResult.json()).data;
      await expect(allowance).toHaveCount(0);
      const record = (viewport.width < 1024 ? page.locator("article") : page.getByRole("row")).filter({ hasText: label }).first();
      await record.getByRole("button", { name: "Draft", exact: true }).click();
      const builder = page.getByRole("dialog");
      await builder.getByLabel("Invoice number", { exact: true }).fill(invoiceNumber);
      const dates = builder.getByLabel("Service date", { exact: true }).filter({ visible: true });
      await expect(dates).toHaveCount(22);
      for (const value of await dates.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))) {
        expect(value.startsWith(viewport.month)).toBe(true);
        expect(new Date(`${value}T00:00:00Z`).getUTCDay()).not.toBe(6);
      }
      // Both selected months begin on Saturday; adding a date must still be eligible.
      await builder.getByRole("button", { name: "Add date", exact: true }).click();
      expect(await dates.last().inputValue()).toBe(`${viewport.month}-02`);
      await builder.getByRole("button", { name: "22 dates", exact: true }).click();
      await expect(dates).toHaveCount(22);
      const draftResponse = page.waitForResponse((response) => response.url().endsWith("/api/classes/invoices") && response.request().method() === "POST");
      await builder.getByRole("button", { name: "Save draft", exact: true }).click();
      const savedDraftResponse = await draftResponse;
      expect(savedDraftResponse.status()).toBe(201);
      const draft = (await savedDraftResponse.json()).data;
      await expect(builder).toHaveCount(0);
      const readBudget = async () => (await (await page.request.get(`/api/classes/budgets/${budget.id}`)).json()).data;
      expect(await readBudget()).toMatchObject({ consumedAmount: "0.0000", remainingAmount: "20000.0000" });
      const preview = await page.request.get(`/api/classes/invoices/${draft.id}/pdf?preview=1`);
      expect(preview.status()).toBe(200);
      expect((await PDFDocument.load(await preview.body())).getTitle()).toBe(`DRAFT - Invoice ${invoiceNumber}`);
      await record.getByRole("button", { name: "Preview draft cover sheet", exact: true }).click();
      const cover = page.getByRole("dialog");
      await cover.getByLabel("Listed in Life Plan").check();
      await cover.getByLabel("Form completed by").fill("Synthetic authorized representative");
      await cover.getByRole("button", { name: "Save profile", exact: true }).click();
      await expect(cover.getByRole("status")).toHaveText("Saved");
      const coverPreview = await page.request.get(`/api/classes/invoices/${draft.id}/cover-sheet?preview=1`);
      expect(coverPreview.status()).toBe(200);
      expect((await PDFDocument.load(await coverPreview.body())).getTitle()).toBe(`DRAFT - Reimbursement application ${invoiceNumber}`);
      expect((await page.request.post(`/api/classes/invoices/${draft.id}/cover-sheet`, { data: {} })).status()).toBe(409);
      await page.keyboard.press("Escape");
      await record.getByRole("button", { name: "Issue", exact: true }).click();
      await expect(record.getByRole("button", { name: "Void invoice", exact: true })).toBeVisible();
      expect(await readBudget()).toMatchObject({ consumedAmount: "3300.0000", remainingAmount: "16700.0000" });
      expect((await page.request.post(`/api/classes/invoices/${draft.id}/issue`, { data: {} })).status()).toBe(409);
      const issuedPdf = await page.request.get(`/api/classes/invoices/${draft.id}/pdf`);
      expect(issuedPdf.status()).toBe(200);
      expect((await PDFDocument.load(await issuedPdf.body())).getTitle()).toBe(`Invoice ${invoiceNumber}`);
      expect((await page.request.post(`/api/classes/invoices/${draft.id}/cover-sheet`, { data: {} })).status()).toBe(200);
      expect((await page.request.get(`/api/classes/invoices/${draft.id}/cover-sheet`)).status()).toBe(200);

      const receiptInput = { serviceDate: draft.invoiceDate, sourceType: "class", sourceRef: invoiceNumber, grossAmount: "3300", notes: "Synthetic actual payment" };
      expect((await page.request.post("/api/agency-financials/income", { data: receiptInput })).status()).toBe(403);
      await signIn(ownerPage, owner);
      const receiptResponse = await ownerPage.request.post("/api/agency-financials/income", { data: receiptInput });
      expect(receiptResponse.status()).toBe(201);
      const receipt = (await receiptResponse.json()).data;
      // The seeded approved 75% split takes precedence over ad-hoc assumptions.
      expect(receipt).toMatchObject({ individualId: LINKED_INDIVIDUAL_ID, agencyAmount: "2475.0000", individualAmount: "825.0000" });
      expect(await readBudget()).toMatchObject({ consumedAmount: "3300.0000", remainingAmount: "16700.0000" });

      await record.getByRole("button", { name: "Void invoice", exact: true }).click();
      const reason = page.getByRole("dialog");
      await reason.getByLabel("Reason", { exact: true }).fill("Synthetic invoice void acceptance");
      await reason.getByRole("button", { name: "Void invoice", exact: true }).click();
      await expect(reason).toHaveCount(0);
      expect(await readBudget()).toMatchObject({ consumedAmount: "0.0000", remainingAmount: "20000.0000" });
      expect((await page.request.post(`/api/classes/invoices/${draft.id}/void`, { data: { reason: "Repeated void acceptance" } })).status()).toBe(409);
      expect((await ownerPage.request.post(`/api/agency-financials/income/${receipt.id}/void`, { data: { reason: "Synthetic payment returned" } })).status()).toBe(200);
      const history = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Invoice history', exact: true }) });
      const voidRecord = (viewport.width < 1024 ? history.locator('article') : history.getByRole('row')).filter({ hasText: invoiceNumber });
      const downloadPromise = page.waitForEvent('download');
      await voidRecord.getByRole('link', { name: 'Download VOID invoice PDF', exact: true }).click();
      const download = await downloadPromise;
      const stream = await download.createReadStream(); const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      const voidBytes = Buffer.concat(chunks);
      expect(await pdfText(voidBytes)).toContain('VOID');
      expect(await pdfText(voidBytes)).toContain('Synthetic invoice void acceptance');
      expect((await PDFDocument.load(voidBytes)).getTitle()).toBe(`VOID - Invoice ${invoiceNumber}`);
      await testInfo.attach(`void-invoice-${viewport.name}`, { body: voidBytes, contentType: 'application/pdf' });
      await voidRecord.getByRole('button', { name: 'Open VOID cover history', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('Finalized cover');
      await expect(page.getByRole('dialog').getByLabel('Form completed by')).toHaveValue('Synthetic authorized representative');
      await expect(page.getByRole('dialog').getByLabel('Form completed by')).toBeDisabled();
      await testInfo.attach(`void-history-${viewport.name}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await page.keyboard.press('Escape');
      await expectNoHorizontalOverflow(page);
      await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);
    } finally {
      await context.close();
      await ownerContext.close();
    }
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
