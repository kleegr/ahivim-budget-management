import { test, expect } from "@playwright/test";
import { LINKED_INDIVIDUAL_ID, REPRESENTATIVE_ACCOUNTS, passwordFor } from "./fixtures";

test("redesigned person and Money workspaces retain usable desktop and phone layouts", async ({ page }, testInfo) => {
  const owner = REPRESENTATIVE_ACCOUNTS.find(account => account.preset === "owner")!;
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(owner.email);
  await page.getByLabel("Password", { exact: true }).fill(passwordFor(owner));
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(url => url.pathname === owner.expectedPath);
  for (const [name, path, title] of [
    ["person", `/individuals/${LINKED_INDIVIDUAL_ID}`, "Linked Individual"],
    ["money-put-away", "/masser?month=2026-09&task=put-away", "Money"],
    ["money-pay", "/settlements?queue=payable&month=2026-09", "Money"],
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
    for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${name} overflow at ${viewport.width}`).toBe(true);
      await testInfo.attach(`${name}-after-${viewport.width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  }
});

for (const account of REPRESENTATIVE_ACCOUNTS.filter(account => account.preset !== "owner" && account.preset !== "office_manager")) {
  test(`${account.preset} uses its own clear home and permitted navigation on desktop and phone`, async ({ page }, testInfo) => {
    await page.goto("/signin");
    await page.getByLabel("Email address").fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(passwordFor(account));
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL(url => url.pathname === account.expectedPath);
    await expect(page.locator("#main").getByRole("heading", { level: 1 })).toBeVisible();
    if (["individual_parent", "employee", "agency", "agency_collector"].includes(account.preset)) {
      await expect(page.getByRole("link", { name: "People", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Financial setup", exact: true })).toHaveCount(0);
    }
    if (account.preset === "agency_staffing_manager") {
      const utilization = await page.request.get(`/api/schedule/utilization?individualId=${LINKED_INDIVIDUAL_ID}`);
      expect(utilization.status()).toBe(403);
      await expect(page.getByText("Hours authorized", { exact: true })).toHaveCount(0);
    }
    for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${account.preset} overflow at ${viewport.width}`).toBe(true);
      await testInfo.attach(`${account.preset}-after-${viewport.width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  });
}
