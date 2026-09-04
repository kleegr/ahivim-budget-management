import { test, expect } from "@playwright/test";

/**
 * Public + health-check smoke tests. These run unauthenticated (Playwright
 * gives every test a fresh context with no session cookie).
 */
test.describe("public / health", () => {
  test("sign-in page renders the sign-in form", async ({ page }) => {
    await page.goto("/signin");

    await expect(page).toHaveTitle(/Sign in/i);
    await expect(
      page.getByRole("heading", { level: 1, name: "Budget Management" }),
    ).toBeVisible();
    await expect(page.getByText("Ahivim", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText(
        "Sign in to review authorizations, imports and payroll transactions.",
      ),
    ).toBeVisible();

    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
  });

  test("GET /api/health/db reports database health without operational detail", async ({ request }) => {
    const res = await request.get("/api/health/db");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.migrationsApplied).toBe(true);
    expect(body.detail).toBe("public");
    expect(body).not.toHaveProperty("tableCount");
    expect(body).not.toHaveProperty("connectionVariable");
  });

  test("GET /api/health/schema reports the schema is current", async ({ request }) => {
    const res = await request.get("/api/health/schema");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.healthy).toBe(true);
  });

  test("GET /api/health/env reports aggregate configuration readiness", async ({ request }) => {
    const res = await request.get("/api/health/env");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, configured: true, detail: "public" });
  });

  test("unauthenticated /dashboard redirects to sign-in", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/signin(\?|$)/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Budget Management" }),
    ).toBeVisible();
    // The intended destination is preserved for after sign-in.
    expect(new URL(page.url()).searchParams.get("next")).toBe("/dashboard");
  });
});
