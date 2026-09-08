import { expect, test, type Page, type Route } from "@playwright/test";
import { Pool } from "pg";
import {
  ADMIN_EMAIL, ADMIN_PASSWORD, EXPECTED_DISPOSABLE_DB_HOST, LINKED_INDIVIDUAL_ID,
  RESET_CONFIRMATION, TEST_DB_URL, assertSafeE2eDatabaseReset,
} from "./fixtures";

const STATEMENT_PATH = `/masser/individuals/${LINKED_INDIVIDUAL_ID}`;
const STATEMENT = `${STATEMENT_PATH}?month=2026-09`;
const FINANCIAL_TABLES = ["payroll_transactions", "employee_payroll_checks", "settlement_obligations",
  "settlement_obligation_transactions", "settlement_events", "settlement_ledger_state", "service_allocations",
  "service_sessions", "budget_authorizations", "budget_periods", "program_budget_events", "calculation_strategies",
  "calculation_strategy_revisions", "import_rows", "import_warnings", "sheet_sync_rows", "sheet_sync_conflicts",
  "sheet_sync_runs", "rate_exceptions"] as const;

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(url => ["/dashboard", "/home"].includes(url.pathname));
}

test.describe("Masser statement document navigation", () => {
  let pool: Pool;
  test.beforeAll(() => {
    assertSafeE2eDatabaseReset({ connectionString: TEST_DB_URL,
      expectedHost: EXPECTED_DISPOSABLE_DB_HOST, confirmation: RESET_CONFIRMATION });
    pool = new Pool({ connectionString: TEST_DB_URL, max: 1,
      options: "-c default_transaction_read_only=on" });
  });
  test.afterAll(async () => { await pool?.end(); });

  async function financialFacts() {
    const controls: Record<string, unknown> = {};
    for (const table of FINANCIAL_TABLES) controls[table] = (await pool.query(`SELECT
      count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS hash
      FROM ${table} t`)).rows[0];
    return controls;
  }

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    test(`opens the exact statement while its prefetched route remains stalled at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const before = await financialFacts();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await signIn(page);

      // Hold only the statement's RSC/prefetch requests. The real document route,
      // authentication and financial response are never mocked or replaced.
      let heldStreams = 0;
      let releaseStreams!: () => void;
      const stalled = new Promise<void>(resolve => { releaseStreams = resolve; });
      const holdStatementStream = async (route: Route) => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname === STATEMENT_PATH && (url.searchParams.has("_rsc") || request.headers().rsc === "1")) {
          heldStreams += 1;
          await stalled;
          await route.abort().catch(() => undefined);
        } else await route.continue();
      };
      await page.route("**/masser/individuals/**", holdStatementStream);
      try {
        expect((await page.goto("/masser?month=2026-09"))?.status()).toBe(200);
        const row = page.locator("#main").getByRole("row").filter({ hasText: "Linked Individual" });
        await expect(row).toContainText("Held balances excluded");
        const link = row.getByRole("link", { name: "View statement", exact: true });
        await expect(link).toHaveAttribute("href", STATEMENT);

        // Reproduce an already-started prefetch even with the document anchor.
        // Do not await that request: its stream stays blocked during the click.
        await page.evaluate(href => {
          void fetch(`${href}&_rsc=statement-navigation-regression`, {
            headers: { RSC: "1", "Next-Router-Prefetch": "1" },
          }).catch(() => undefined);
        }, STATEMENT);
        await expect.poll(() => heldStreams).toBeGreaterThan(0);
        const documentResponse = page.waitForResponse(response => {
          const request = response.request(), url = new URL(response.url());
          return url.pathname === STATEMENT_PATH && request.isNavigationRequest()
            && request.resourceType() === "document" && request.method() === "GET";
        }, { timeout: 10_000 });
        const [, response] = await Promise.all([link.click(), documentResponse]);
        expect(response.status()).toBe(200);
        expect(response.headers()["content-type"]).toContain("text/html");
        expect(new URL(response.url()).origin).toBe(new URL(page.url()).origin);
        await expect(page).toHaveURL(new URL(STATEMENT, page.url()).href);
        const main = page.locator("#main");
        await expect(main.getByRole("heading", { level: 1, name: "Linked Individual", exact: true })).toBeVisible();
        await expect(main.getByText("Source review required", { exact: true })).toBeVisible();
        await expect(main.getByText("Approved monthly plan", { exact: true }).locator("..")).toContainText("$260.00");
        for (const label of ["Remaining in plan period", "Recorded over plan period", "Credit"]) {
          await expect(main.getByText(label, { exact: true }).locator("..")).toContainText("$0.00");
        }
        expect(await financialFacts()).toEqual(before);
        expect(errors).toEqual([]);
      } finally {
        releaseStreams();
        await page.unroute("**/masser/individuals/**", holdStatementStream);
      }
    });
  }
});
