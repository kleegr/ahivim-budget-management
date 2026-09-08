import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./fixtures";

async function settings(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL("**/dashboard");
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Team access" })).toBeVisible();
}

function accountRow(page: Page, email: string) {
  return page.locator(".divide-y > div").filter({ has: page.getByText(email, { exact: false }) });
}

async function createLogin(page: Page, email: string) {
  await page.getByRole("button", { name: "Add person", exact: true }).click();
  const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "New login" }) });
  await form.getByLabel("Name", { exact: true }).fill("D2 feedback fixture");
  await form.getByLabel("Email", { exact: true }).fill(email);
  await form.getByLabel("What will they do?").selectOption("custom_access");
  await form.getByRole("button", { name: "Create login", exact: true }).click();
  const credential = page.getByRole("status").filter({ hasText: `Login created for ${email}` });
  await expect(credential).toBeVisible();
  return (await credential.locator("code").textContent())!;
}

async function savedAccount(page: Page, email: string) {
  const response = await page.request.get("/api/admin/users");
  expect(response.status()).toBe(200);
  const data = await response.json();
  return data.users.find((user: { email: string }) => user.email === email) as { id: string; isActive: boolean };
}

test("account creation and disable/re-enable finish while Settings RSC requests cannot finish", async ({ page, browser }) => {
  await settings(page);
  let releaseRsc!: () => void;
  const blockedRsc = new Promise<void>((resolve) => { releaseRsc = resolve; });
  await page.route("**/settings?*", async (route) => {
    if (route.request().headers().rsc !== "1") return route.continue();
    await blockedRsc;
    await route.abort().catch(() => undefined);
  });
  const email = `d2-feedback-${randomUUID()}@ahivim.test`;
  try {
    const password = await createLogin(page, email);
    const row = accountRow(page, email);
    await expect(row.getByRole("button", { name: "Disable", exact: true })).toBeEnabled();
    expect((await savedAccount(page, email)).isActive).toBe(true);
    await row.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(row.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
    expect((await savedAccount(page, email)).isActive).toBe(false);
    await row.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(row.getByRole("button", { name: "Disable", exact: true })).toBeEnabled();
    expect((await savedAccount(page, email)).isActive).toBe(true);
    const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const target = await context.newPage();
      await target.goto("/signin");
      await target.getByLabel("Email address").fill(email);
      await target.getByLabel("Password", { exact: true }).fill(password);
      await target.getByRole("button", { name: /^sign in$/i }).click();
      await target.waitForURL("**/home");
      await row.getByRole("button", { name: "Disable", exact: true }).click();
      await expect(row.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
      expect((await target.request.get("/api/employees")).status()).toBe(401);
    } finally { await context.close(); }
  } finally {
    releaseRsc();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("committed account changes retain credentials and recover from failed or stalled account reloads without repeating mutations", async ({ page }) => {
  await settings(page);
  const accountAlert = page.locator("section").filter({ has: page.getByRole("heading", { name: "Team access" }) }).getByRole("alert");
  let reloadMode: "fail" | "stall" | "pass" = "fail";
  let releaseReload!: () => void;
  const blockedReload = new Promise<void>((resolve) => { releaseReload = resolve; });
  let creates = 0; let changes = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/admin/users" && request.method() === "POST") creates += 1;
    if (pathname.startsWith("/api/admin/users/") && request.method() === "PATCH") changes += 1;
  });
  await page.route("**/api/admin/users", async (route) => {
    if (route.request().method() !== "GET" || reloadMode === "pass") return route.continue();
    if (reloadMode === "fail") return route.fulfill({ status: 503, json: { ok: false, error: "Synthetic unavailable list" } });
    await blockedReload;
    await route.abort().catch(() => undefined);
  });
  const email = `d2-reload-${randomUUID()}@ahivim.test`;
  try {
    const password = await createLogin(page, email);
    await expect(accountAlert).toContainText("The change was saved");
    const credential = page.getByRole("status").filter({ hasText: `Login created for ${email}` });
    await expect(credential.locator("code")).toHaveText(password);
    expect((await savedAccount(page, email)).isActive).toBe(true);
    reloadMode = "pass";
    await page.getByRole("button", { name: "Reload accounts", exact: true }).click();
    const row = accountRow(page, email);
    await expect(row.getByRole("button", { name: "Disable", exact: true })).toBeEnabled();
    await expect(accountAlert).toHaveCount(0);
    expect(creates).toBe(1);

    reloadMode = "stall";
    await row.getByRole("button", { name: "Disable", exact: true }).click();
    await expect.poll(async () => (await savedAccount(page, email)).isActive).toBe(false);
    await expect(accountAlert).toContainText("The change was saved", { timeout: 15_000 });
    await expect(row.getByRole("button", { name: "Disable", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Reload accounts", exact: true })).toBeEnabled();
    reloadMode = "pass";
    await page.getByRole("button", { name: "Reload accounts", exact: true }).click();
    await expect(row.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
    await expect(credential.locator("code")).toHaveText(password);
    expect(creates).toBe(1); expect(changes).toBe(1);
    await row.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(row.getByRole("button", { name: "Disable", exact: true })).toBeEnabled();
    expect((await savedAccount(page, email)).isActive).toBe(true);
  } finally {
    releaseReload();
    await page.unrouteAll({ behavior: "wait" });
  }
});
