import { expect, test } from "@playwright/test";
import { REPRESENTATIVE_ACCOUNTS, passwordFor } from "./fixtures";

for (const preset of ["owner", "budget_planner", "agency_scheduler"] as const) {
  test(`${preset} opens matching from Calendar on the first normal interaction and returns with Back`, async ({ page }, testInfo) => {
    const account = REPRESENTATIVE_ACCOUNTS.find((entry) => entry.preset === preset)!;
    await page.goto("/signin");
    await page.getByLabel("Email address").fill(account.email);
    await page.getByLabel("Password").fill(passwordFor(account));
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL((url) => url.pathname !== "/signin");
    await page.goto("/schedule");
    await expect(page.getByRole("tab", { name: "Calendar", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Recorded match review", exact: true }).click();
    // The ordinary tab now fetches its server panel. Older builds only changed
    // history, leaving Open review pointing at the URL already in the address bar.
    await expect(page.getByRole("heading", { name: "Recorded service match review", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open review", exact: true })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Find a person, employee, or program" }).fill("no-such-synthetic-review-person");
    await page.getByRole("button", { name: "Search review", exact: true }).click();
    await expect(page.getByText("No visits match these filters.", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Recorded service match review", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("tab", { name: "Calendar", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "Recorded match review", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Recorded service match review", exact: true })).toBeVisible();
    await expect(page.getByText("Loading view…", { exact: true })).toHaveCount(0);
    await testInfo.attach(`${preset}-matching-phone`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  });
}
