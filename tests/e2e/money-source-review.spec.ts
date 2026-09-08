import { expect, test } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./fixtures";

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`Masser refresh discloses held setup balances at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/signin");
    await page.getByLabel("Email address").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL((url) => url.pathname === "/dashboard");
    await page.goto("/settlements?queue=all");

    // PostgreSQL tests cover hold generation and immutable facts. Isolate the
    // response presentation here: setup-only review has no skipped payroll rows
    // and must never be announced as fully up to date.
    let refreshRequests = 0;
    await page.route("**/api/settlements/refresh", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({});
      refreshRequests++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: {
          created: 0, updated: 0, adjusted: 0, voided: 0, unchanged: 0,
          skippedNoDeal: 0, skippedMissingCheckIdentity: 0, skippedMissingNet: 0,
          skippedInconsistentNet: 0, skippedInconsistentCheck: 0,
          skippedMissingBase: 0, skippedUnknownRecipient: 0,
          reviewRequiredCount: 3, amountBasisReviewCount: 3,
        } }),
      });
    });
    await page.getByRole("button", { name: "Refresh items", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText:
      "Refresh finished. 3 financial items still need review. Affected balances remain on hold.",
    })).toBeVisible();
    await expect(page.getByText("Payment items are up to date.", { exact: true })).toHaveCount(0);
    expect(refreshRequests).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
