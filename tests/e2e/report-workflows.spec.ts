import { expect, test, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, LINKED_INDIVIDUAL_ID, PRIMARY_CALCULATION_ACCOUNT } from "./fixtures";

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(url => url.pathname === "/dashboard");
}

test("one transaction investigation retains dates and selected services across all views, reload and keyboard navigation", async ({ page }, testInfo) => {
  await signIn(page);
  await page.getByRole("link", { name: "Transactions", exact: true }).first().click();
  await page.getByRole("tab", { name: "Payroll checks", exact: true }).click();
  await page.getByPlaceholder("Search checks", { exact: true }).fill("Linked Individual");
  await page.getByLabel("Check date from", { exact: true }).fill("2026-09-01");
  await page.getByLabel("Check date to", { exact: true }).fill("2026-09-30");
  const scope = page.getByRole("region", { name: "Investigation scope" });
  await expect(scope).toContainText("Search: Linked Individual");
  const selected = await scope.locator("p").first().innerText();
  expect(selected).not.toMatch(/^0 /);
  const savedScope = new URL(page.url()).searchParams.get("scope");
  for (const view of ["Source payments", "Recorded services", "Payroll checks"]) {
    await page.getByRole("tab", { name: view, exact: true }).click();
    await expect(scope.locator("p").first()).toHaveText(selected);
    await expect(page.getByLabel("Check date from")).toHaveValue("2026-09-01");
    await expect(page.getByLabel("Check date to")).toHaveValue("2026-09-30");
    expect(new URL(page.url()).searchParams.get("scope")).toBe(savedScope);
    await page.reload();
    await expect(scope.locator("p").first()).toHaveText(selected);
  }
  await page.getByRole("tab", { name: "Recorded services", exact: true }).click();
  await page.getByRole("tab", { name: "Recorded services", exact: true }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Payroll checks", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await testInfo.attach("transactions-shared-scope-mobile", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

test("financial rate preview needs Save, preserves failed drafts, reopens persisted rate and leaves approved final unchanged", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.goto("/calculations");
  const row = page.getByRole("row").filter({ hasText: PRIMARY_CALCULATION_ACCOUNT }).first();
  const response = page.waitForResponse(r => /\/api\/calculation-strategies\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === "GET");
  await row.getByRole("button", { name: "Explain", exact: true }).click();
  const initialResponse = await response;
  const endpoint = new URL(initialResponse.url()).pathname;
  const initial = (await initialResponse.json()).data.explain;
  const line = initial.lineGross.find((entry: { programId?: string }) => entry.programId);
  expect(line).toBeTruthy();
  const draftRate = String(Number(line.rate) + 1.25);
  const drawer = page.getByRole("dialog");
  const edit = () => drawer.getByRole("button", { name: `Edit rate for ${line.programLabel}`, exact: true }).click();
  let writes = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === endpoint && request.method() === "PATCH") writes++; });
  try {
    await edit();
    await drawer.getByLabel("Rate per hour").fill(draftRate);
    await drawer.getByLabel("Rate per hour").press("Tab");
    await expect(drawer.getByText(/^Yearly gross:/)).toContainText("→");
    await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(writes).toBe(0);
    await edit();
    await drawer.getByLabel("Rate per hour").fill(draftRate);
    await page.route(`**${endpoint}`, async route => {
      if (route.request().method() === "PATCH") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary rate save failure" }) });
      else await route.continue();
    });
    await drawer.getByRole("button", { name: "Save rate", exact: true }).click();
    await expect(drawer.getByRole("alert")).toContainText("Temporary rate save failure");
    await expect(drawer.getByLabel("Rate per hour")).toHaveValue(draftRate);
    expect((await (await page.request.get(endpoint)).json()).data.explain.afterAll).toBe(initial.afterAll);
    await page.unroute(`**${endpoint}`);
    await drawer.getByRole("button", { name: "Save rate", exact: true }).click();
    await expect(drawer.getByRole("status")).toContainText("approved final amount is unchanged");
    await drawer.getByRole("button", { name: "Close calculation details" }).click();
    await page.reload();
    await row.getByRole("button", { name: "Explain", exact: true }).click();
    await edit();
    await expect(drawer.getByLabel("Rate per hour")).toHaveValue(draftRate);
    const persisted = (await (await page.request.get(endpoint)).json()).data.explain;
    expect(Number(persisted.lineGross.find((entry: { programId: string }) => entry.programId === line.programId).rate)).toBe(Number(draftRate));
    expect(persisted.afterAll).toBe(initial.afterAll);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await testInfo.attach("financial-rate-saved-mobile", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  } finally {
    await page.unroute(`**${endpoint}`);
    expect((await page.request.patch(endpoint, { data: { rateOverrides: { [line.programId]: line.isOverride ? line.rate : null } } })).status()).toBe(200);
  }
});

test("calendar context survives create, reopen and a move to another day", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signIn(page);
  const programs = (await (await page.request.get("/api/programs")).json()).data;
  const program = programs.find((entry: { code: string }) => entry.code === "COM_HAB");
  await page.goto(`/schedule?view=calendar&individualId=${LINKED_INDIVIDUAL_ID}&programId=${program.id}&date=2026-09-14&calendarView=day`);
  await expect(page.getByLabel("Filter by program")).toHaveValue(program.id);
  await page.getByRole("button", { name: "Add session", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "New one-time session" });
  await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue("2026-09-14");
  await dialog.getByLabel("Start", { exact: true }).fill("06:00");
  await dialog.getByLabel("End", { exact: true }).fill("08:00");
  await dialog.getByLabel("Notes", { exact: true }).fill("Synthetic report persistence journey");
  const saved = page.waitForResponse(r => new URL(r.url()).pathname === "/api/schedule/sessions" && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Add session", exact: true }).click();
  const created = await saved;
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id;
  await expect(dialog).toHaveCount(0);
  await page.getByRole("link", { name: "View saved visit", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Session", exact: true });
  await expect(dialog).toContainText("Synthetic report persistence journey");
  await dialog.getByRole("button", { name: "Reschedule", exact: true }).click();
  await dialog.getByLabel("Date", { exact: true }).fill("2026-09-15");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("link", { name: "View saved visit", exact: true }).click();
  await page.reload();
  expect(new URL(page.url()).searchParams.get("date")).toBe("2026-09-15");
  const sessions = (await (await page.request.get(`/api/schedule/sessions?from=2026-09-15&to=2026-09-15&individualId=${LINKED_INDIVIDUAL_ID}`)).json()).data.sessions;
  expect(sessions.find((session: { id: string }) => session.id === id)).toMatchObject({ sessionDate: "2026-09-15", durationHours: "2.0000" });
  await expect(page.getByRole("dialog", { name: "Session", exact: true })).toContainText("Synthetic report persistence journey");
  await testInfo.attach("schedule-persisted-session", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});
