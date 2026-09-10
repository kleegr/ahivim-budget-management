import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { readFile } from "node:fs/promises";
import { BASE_URL, REPRESENTATIVE_ACCOUNTS, passwordFor } from "./fixtures";

async function signIn(page: Page, preset: "owner" | "individual_parent") {
  const account = REPRESENTATIVE_ACCOUNTS.find(entry => entry.preset === preset)!;
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(passwordFor(account));
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(url => url.pathname === account.expectedPath);
}

test("private PDF upload, failed save recovery, persisted edits, historical download and restore", async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  await signIn(page, "owner");
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  const original = await PDFDocument.create();
  original.addPage().drawText("Synthetic isolated document version journey");
  const originalBytes = Buffer.from(await original.save());
  const filename = `Version-journey-${Date.now()}.pdf`;
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload PDF", exact: true }).first().click();
  await (await chooser).setFiles({ name: filename, mimeType: "application/pdf", buffer: originalBytes });
  await page.waitForURL(url => url.pathname === "/documents/pdf-editor" && url.searchParams.has("document"));
  const documentId = new URL(page.url()).searchParams.get("document")!;
  const detail = async () => (await (await page.request.get(`/api/documents/${documentId}`)).json()).data;
  await expect(page.getByText("v1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open page 1", exact: true })).toBeVisible();
  const initial = await detail();
  expect(initial.versions).toHaveLength(1);
  const originalId = initial.document.originalVersionId;

  await page.getByRole("button", { name: "Duplicate page", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open page 2", exact: true })).toBeVisible();
  await page.route("**/api/documents/uploads", async route => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary isolated storage failure. Try again." }) });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Temporary isolated storage failure" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open page 2", exact: true })).toBeVisible();
  expect((await detail()).versions).toHaveLength(1);
  await page.unroute("**/api/documents/uploads");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await expect(page.getByText("v2", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Documents", exact: true }).last().click();
  await page.getByRole("button", { name: new RegExp(filename.replace(/\.pdf$/, "").replaceAll("-", " ")) }).first().click();
  await page.waitForURL(url => url.pathname === "/documents/pdf-editor" && url.searchParams.get("document") === documentId);
  await expect(page.getByText("v2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open page 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download version 2", exact: true }).click();
  const file = await download;
  const downloadPath = await file.path();
  expect(downloadPath).toBeTruthy();
  expect((await PDFDocument.load(await readFile(downloadPath!))).getPageCount()).toBe(2);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Restore version 1", exact: true }).click();
  await expect(page.getByText("v3", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("v3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open page 2", exact: true })).toHaveCount(0);
  const restored = await detail();
  expect(restored.versions).toHaveLength(3);
  const originalResponse = await page.request.get(`/api/documents/${documentId}/versions/${originalId}/file?source=1`);
  expect(originalResponse.status()).toBe(200);
  expect(Buffer.from(await originalResponse.body())).toEqual(originalBytes);
  for (const version of restored.versions) {
    const response = await page.request.get(`/api/documents/${documentId}/versions/${version.id}/file?download=1`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("private");
    expect((await PDFDocument.load(await response.body())).getPageCount()).toBe(version.versionNumber === 2 ? 2 : 1);
  }
  const parentContext = await browser.newContext({ baseURL: BASE_URL });
  try {
    const parent = await parentContext.newPage();
    await signIn(parent, "individual_parent");
    for (const version of restored.versions) {
      for (const query of ["?download=1", "?source=1"]) {
        expect((await parent.request.get(`/api/documents/${documentId}/versions/${version.id}/file${query}`)).status()).toBe(404);
      }
    }
  } finally { await parentContext.close(); }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Save version", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await testInfo.attach("document-restored-mobile", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});
