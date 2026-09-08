import { expect, test, type Browser, type Page } from "@playwright/test";
import { Pool } from "pg";
import {
  BASE_URL, EXPECTED_DISPOSABLE_DB_HOST, REPRESENTATIVE_ACCOUNTS, RESET_CONFIRMATION,
  TEST_DB_URL, assertSafeE2eDatabaseReset, passwordFor, type RepresentativeAccount,
} from "./fixtures";

const ENDPOINT = "/api/sync/source-base-recovery";
const REVIEW_PAGE = "/exceptions?kind=rate";
const INVALID_ACTION = "source_base_access_boundary_probe";
const ACCESS_ERROR = "You need the manager role to review source-based amounts.";
const VIEWPORTS = [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 390, height: 844 }] as const;
const FINANCIAL_TABLES = ["payroll_transactions", "employee_payroll_checks", "settlement_obligations",
  "settlement_obligation_transactions", "settlement_events", "settlement_ledger_state", "service_allocations",
  "service_sessions", "budget_authorizations", "budget_periods", "program_budget_events", "calculation_strategies",
  "calculation_strategy_revisions", "import_rows", "import_warnings", "sheet_sync_rows", "sheet_sync_conflicts", "rate_exceptions"] as const;

async function signIn(page: Page, account: RepresentativeAccount) {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(passwordFor(account));
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(url => url.pathname === account.expectedPath);
}

async function verifyInvalidActionBoundary(page: Page, allowed: boolean) {
  // An unsupported action stops at route validation, before the financial
  // service or a source read. Use the browser's real same-origin session.
  const requestPromise = page.waitForRequest(request => new URL(request.url()).pathname === ENDPOINT
    && request.method() === "POST");
  const result = await page.evaluate(async ({ endpoint, action }) => {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }) });
    return { status: response.status, body: await response.json(),
      contentType: response.headers.get("content-type"), disposition: response.headers.get("content-disposition") };
  }, { endpoint: ENDPOINT, action: INVALID_ACTION });
  const request = await requestPromise;
  expect(await request.headerValue("origin")).toBe(new URL(BASE_URL).origin);
  expect(request.postDataJSON()).toEqual({ action: INVALID_ACTION });
  expect(result.status).toBe(allowed ? 400 : 403);
  // Exact minimal payload also excludes financial values, source IDs and PII.
  expect(result.body).toEqual({ ok: false, error: allowed ? "Choose accept or undo." : ACCESS_ERROR });
  expect(result.contentType).toContain("application/json");
  expect(result.disposition).toBeNull();
}

async function verifyDeniedPage(page: Page, signedOut = false) {
  // Inspect the original response too: a streamed redirect must not include
  // financial source props before redirecting to an allowed landing screen.
  const response = await page.request.get(REVIEW_PAGE, { maxRedirects: 0 });
  const raw = await response.text();
  for (const forbidden of ["Employee base corrections", "source-base-history-", "Source Base Individual",
    "Source Base Employee", "spreadsheet_internal_amount", "calculated_internal_amount", "E2E-PRIVATE"]) {
    expect(raw, `denied source review serialized ${forbidden}`).not.toContain(forbidden);
  }
  await page.goto(REVIEW_PAGE);
  await page.waitForURL(url => signedOut ? url.pathname === "/signin" : url.pathname !== "/exceptions");
  await expect(page.locator("#source-base-recovery")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Employee base corrections", exact: true })).toHaveCount(0);
  await expect(page.getByText("Source Base Individual", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Source Base Employee", { exact: true })).toHaveCount(0);
}

async function withDirectContext(browser: Browser, viewport: typeof VIEWPORTS[number],
  check: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  const runtimeErrors: string[] = [];
  page.on("pageerror", error => runtimeErrors.push(error.message));
  try {
    await check(page);
    expect(runtimeErrors).toEqual([]);
  } finally { await context.close(); }
}

test.describe("Source base correction real-session access boundary", () => {
  let pool: Pool;
  let originalFinancialControls: Record<string, unknown>;
  async function financialControls() {
    const controls: Record<string, unknown> = {};
    for (const table of FINANCIAL_TABLES) controls[table] = (await pool.query(`SELECT
      count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS hash
      FROM ${table} t`)).rows[0];
    controls.sourceBaseAudits = (await pool.query(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS hash FROM audit_logs t
      WHERE action IN ('source_base_recovery_accepted','source_base_recovery_reversed',
        'source_base_recovery_batch_accepted','source_base_recovery_batch_reversed')`)).rows[0];
    return controls;
  }

  test.beforeAll(async () => {
    assertSafeE2eDatabaseReset({ connectionString: TEST_DB_URL,
      expectedHost: EXPECTED_DISPOSABLE_DB_HOST, confirmation: RESET_CONFIRMATION });
    // No seed, schema reset or direct mutation belongs to this access spec.
    pool = new Pool({ connectionString: TEST_DB_URL, max: 1, options: "-c default_transaction_read_only=on" });
    originalFinancialControls = await financialControls();
  });
  test.afterAll(async () => {
    if (!pool) return;
    try { if (originalFinancialControls) expect(await financialControls()).toEqual(originalFinancialControls); }
    finally { await pool.end(); }
  });

  for (const account of REPRESENTATIVE_ACCOUNTS) {
    test(`${account.preset} has the correct source-base boundary on desktop and phone`, async ({ browser }) => {
      const allowed = account.preset === "owner" || account.preset === "office_manager";
      for (const viewport of VIEWPORTS) await test.step(viewport.name, () => withDirectContext(browser, viewport, async page => {
        await signIn(page, account);
        await verifyInvalidActionBoundary(page, allowed);
        if (!allowed) await verifyDeniedPage(page);
      }));
    });
  }

  test("signed-out desktop and phone sessions receive no source-base data or action access", async ({ browser }) => {
    for (const viewport of VIEWPORTS) await test.step(viewport.name, () => withDirectContext(browser, viewport, async page => {
      await page.goto("/signin");
      await verifyInvalidActionBoundary(page, false);
      await verifyDeniedPage(page, true);
    }));
  });
});
