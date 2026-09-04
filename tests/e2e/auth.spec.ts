import { test, expect, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./fixtures";

/**
 * Authenticated smoke: sign in through the real form (against the admin the
 * global setup seeded directly into the test database), then load every primary
 * workspace and assert each returns 200 and renders its page header with no
 * error boundary and no uncaught page errors.
 */

const WORKSPACES: { path: string; title: RegExp; heading: RegExp }[] = [
  { path: "/dashboard", title: /Home - Ahivim/, heading: /^(Owner overview|Home)$/ },
  { path: "/transactions", title: /Activity - Ahivim/, heading: /^Activity$/ },
  { path: "/calculations", title: /Financial setup - Ahivim/, heading: /^Financial setup$/ },
  { path: "/individuals", title: /People & budgets - Ahivim Budget Management/, heading: /^People & budgets$/ },
  { path: "/reports", title: /Reports - Ahivim Budget Management/, heading: /^Reports$/ },
  { path: "/schedule", title: /Schedule - Ahivim/, heading: /^Scheduling$/ },
  { path: "/employees", title: /Employees — Ahivim Budget Management/, heading: /^Employees$/ },
];

async function signIn(page: Page): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard(\?|$)/, { timeout: 20_000 });
}

test("authenticated smoke: sign in and load every workspace", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(`${page.url()} :: ${error.message}`);
  });

  await signIn(page);
  // Landed on the dashboard with a rendered header.
  await expect(page.locator("#main").getByRole("heading", { level: 1 })).toBeVisible();

  for (const ws of WORKSPACES) {
    const res = await page.goto(ws.path);
    expect(res, `no navigation response for ${ws.path}`).not.toBeNull();
    expect(res!.status(), `HTTP status for ${ws.path}`).toBe(200);

    await expect(page, `document title for ${ws.path}`).toHaveTitle(ws.title);

    const main = page.locator("#main");
    // No error boundary / database error panel (ErrorPanel renders role="alert").
    await expect(
      main.locator('[role="alert"]'),
      `error panel present on ${ws.path}`,
    ).toHaveCount(0);
    // The page header rendered.
    await expect(
      main.getByRole("heading", { level: 1 }),
      `page header on ${ws.path}`,
    ).toHaveText(ws.heading);
  }

  expect(
    pageErrors,
    `uncaught page errors:\n${pageErrors.join("\n")}`,
  ).toEqual([]);
});
