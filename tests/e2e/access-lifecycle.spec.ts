import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { cacheControlDirectives } from "../support/cache-control";
import { ADMIN_EMAIL, ADMIN_PASSWORD, LINKED_EMPLOYEE_ID, LINKED_INDIVIDUAL_ID, UNLINKED_INDIVIDUAL_ID } from "./fixtures";

const PASSWORD = "D2 isolated browser password";
async function signIn(page: Page, email: string, password: string, landing: string) {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.pathname === landing);
}

test("role changes and account revocation apply to the same browser session", async ({ page, browser }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, "/dashboard");
  const origin = new URL(page.url()).origin;
  const email = `d2-lifecycle-${randomUUID()}@ahivim.test`;
  const created = await page.request.post("/api/admin/users", {
    headers: { origin }, data: { preset: "money_collector", email, displayName: "D2 lifecycle", password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).user.id;
  const context = await browser.newContext({ baseURL: origin });
  const target = await context.newPage();
  const update = async (data: Record<string, unknown>) => {
    expect((await page.request.patch(`/api/admin/users/${id}`, { headers: { origin }, data })).status()).toBe(200);
  };
  try {
    await signIn(target, email, PASSWORD, "/home");
    const exportRequest = () => target.request.post("/api/transactions/export", {
      headers: { origin }, data: { format: "csv", columns: [{ key: "value", header: "Value", type: "text" }], rows: [{ value: "D2 same-session export" }] },
    });
    const allowed = await exportRequest();
    expect(allowed.status()).toBe(200);
    const cacheDirectives = cacheControlDirectives(allowed.headers()["cache-control"]);
    expect(cacheDirectives).toEqual(expect.arrayContaining(["private", "no-store"]));
    expect(cacheDirectives).not.toContain("public");
    await update({ preset: "budget_planner" });
    expect((await exportRequest()).status()).toBe(403);
    const roster = await target.request.get("/api/employees");
    expect(roster.status()).toBe(200);
    const employees = (await roster.json()).data;
    expect(employees).toContainEqual(expect.objectContaining({ id: LINKED_EMPLOYEE_ID }));
    for (const employee of employees) {
      expect(Object.keys(employee).sort()).toEqual(["archivedAt", "displayName", "id", "status"]);
    }
    await target.reload();
    await expect(target.locator('nav[aria-label="Primary"] a[href="/masser"]')).toHaveCount(0);

    await update({ isActive: false });
    expect((await target.request.get("/api/employees")).status()).toBe(401);
    await update({ isActive: true });
    expect((await target.request.get("/api/employees")).status()).toBe(401);
    await signIn(target, email, PASSWORD, "/home");
    expect((await target.request.get("/api/employees")).status()).toBe(200);
    const replacement = "D2 replacement browser password";
    await update({ password: replacement });
    expect((await target.request.get("/api/employees")).status()).toBe(401);
    await signIn(target, email, replacement, "/home");
    expect((await target.request.get("/api/employees")).status()).toBe(200);
  } finally {
    await update({ isActive: false });
    await context.close();
  }
});

test("a two-person parent loses both links immediately after a Custom Access switch", async ({ page, browser }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, "/dashboard");
  const origin = new URL(page.url()).origin;
  const email = `d2-parent-${randomUUID()}@ahivim.test`;
  const created = await page.request.post("/api/admin/users", {
    headers: { origin }, data: { preset: "individual_parent", email, displayName: "D2 two-person parent", password: PASSWORD,
      individuals: [LINKED_INDIVIDUAL_ID, UNLINKED_INDIVIDUAL_ID].map((individualId) => ({ individualId, relationship: "parent" })),
    },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).user.id;
  const context = await browser.newContext({ baseURL: origin });
  const target = await context.newPage();
  try {
    await signIn(target, email, PASSWORD, "/portal");
    const portal = await target.request.get("/api/portal/access?month=2026-09");
    expect(portal.status()).toBe(200);
    const people: { id: string; name: string }[] = (await portal.json()).data.individuals;
    expect(people.map((person) => person.id).sort()).toEqual([LINKED_INDIVIDUAL_ID, UNLINKED_INDIVIDUAL_ID].sort());
    const statementPath = (person: string) => `/api/portal/individual-statements?individualId=${person}&month=2026-09&scope=month`;
    for (const person of people) {
      await expect(target.locator("#main").getByRole("heading", { name: person.name, exact: true })).toBeVisible();
      const statement = await target.request.get(statementPath(person.id));
      expect(statement.status()).toBe(200);
      expect(await statement.text()).toContain(person.name);
      // Direct portal bindings do not grant the internal profile/workspace API.
      expect((await target.request.get(`/api/individuals/${person.id}`)).status()).toBe(404);
    }
    expect((await page.request.patch(`/api/admin/users/${id}`, {
      headers: { origin }, data: { preset: "custom_access" },
    })).status()).toBe(200);
    const revoked = await target.request.get("/api/portal/access?month=2026-09");
    expect(revoked.status()).toBe(200);
    expect((await revoked.json()).data).toMatchObject({ individuals: [], employees: [], agencies: [], globalRoles: [] });
    for (const person of [LINKED_INDIVIDUAL_ID, UNLINKED_INDIVIDUAL_ID]) {
      expect((await target.request.get(statementPath(person))).status()).toBe(404);
      expect((await target.request.get(`/api/individuals/${person}`)).status()).toBe(404);
    }
    await target.goto("/home");
    await expect(target.locator('nav[aria-label="Primary"] a[href="/portal"]')).toHaveCount(0);
  } finally {
    expect((await page.request.patch(`/api/admin/users/${id}`, {
      headers: { origin }, data: { isActive: false },
    })).status()).toBe(200);
    await context.close();
  }
});
