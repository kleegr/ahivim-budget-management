import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DB_URL, assertSafeE2eDatabaseReset, EXPECTED_DISPOSABLE_DB_HOST, RESET_CONFIRMATION } from "./fixtures";

// Synthetic records only. The approved monthly final is fixed; the Owner adds
// the one missing fact in the real UI, which saves and refreshes the ledger.
test("Owner saves a missing renewal and records one monthly put-away while history stays held", async ({ page }) => {
  assertSafeE2eDatabaseReset({ connectionString: TEST_DB_URL, expectedHost: EXPECTED_DISPOSABLE_DB_HOST, confirmation: RESET_CONFIRMATION });
  const pool = new Pool({ connectionString: TEST_DB_URL });
  const individualId = randomUUID();
  const strategyId = randomUUID();
  const legacyId = randomUUID();
  const name = "E2E Monthly Resolution Person";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const month = today.slice(0, 7);
  const renewal = `${Number(today.slice(0, 4)) + 1}-01-01`;
  try {
    await pool.query(`INSERT INTO individuals (id, normalized_name, display_name) VALUES ($1, $2, $3)`, [individualId, name.toLowerCase(), name]);
    await pool.query(`INSERT INTO calculation_strategies (id, individual_id, label, after_all, month_divisor, cut1_percent, cut2_percent)
      VALUES ($1, $2, 'Approved monthly test', 100, 7, 0.24, 0.30)`, [strategyId, individualId]);
    await pool.query(`INSERT INTO settlement_obligations (id, source_key, kind, direction, individual_id, calculation_strategy_id, original_amount, period_begin, period_end, calculation_metadata)
      VALUES ($1, $2, 'individual_cut_1', 'reserve', $3, $4, 333, '2026-01-01', '2027-01-01', '{"flow":"individual_plan"}')`, [legacyId, `e2e-monthly-legacy-${individualId}`, individualId, strategyId]);
    const historical = (await pool.query(`SELECT to_jsonb(o) AS fact FROM settlement_obligations o WHERE id=$1`, [legacyId])).rows[0].fact;
    await page.goto("/signin");
    await page.getByLabel("Email address").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL(url => url.pathname === "/dashboard");
    await page.goto(`/masser?month=${month}`);
    let person = page.getByRole("row").filter({ hasText: name });
    await expect(person).toContainText("$100.00");
    await person.getByRole("link", { name: "Add renewal date" }).click();
    await page.getByRole("button", { name: "Edit financial plan", exact: true }).click();
    await page.getByLabel("Projection period end", { exact: false }).fill(renewal);
    const saved = page.waitForResponse(r => r.url().endsWith(`/api/calculation-strategies/${strategyId}`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save financial plan", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await page.goto(`/masser?month=${month}`);
    person = page.getByRole("row").filter({ hasText: name });
    await expect(person).toContainText("Ready");
    await expect(person).toContainText("Historical");
    await person.getByRole("link", { name: "Record set-aside", exact: true }).click();
    const item = page.getByRole("row").filter({ hasText: name }).filter({ hasText: "Approved monthly put-away" });
    await expect(item).toContainText("$100.00");
    await item.getByRole("button", { name: "Record amount", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Record amount - ${name}` });
    await dialog.getByLabel("Amount set aside").fill("20");
    await dialog.getByLabel("Date", { exact: true }).fill(today);
    await dialog.getByLabel(/^Reference/).fill("Synthetic monthly receipt");
    await dialog.getByRole("button", { name: "Record amount", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.goto(`/masser/individuals/${individualId}?month=${month}`);
    await expect(page.getByText("Remaining in plan period", { exact: true }).locator("..")).toContainText("$80.00");
    const monthly = (await pool.query(`SELECT original_amount::text, period_begin::text, period_end::text FROM settlement_obligations WHERE individual_id=$1 AND calculation_metadata->>'amountBasis'='monthly'`, [individualId])).rows;
    expect(monthly).toHaveLength(1);
    expect(monthly[0]).toMatchObject({ original_amount: "100.0000", period_begin: `${month}-01` });
    expect((await pool.query(`SELECT to_jsonb(o) AS fact FROM settlement_obligations o WHERE id=$1`, [legacyId])).rows[0].fact).toEqual(historical);
    await page.screenshot({ path: test.info().outputPath("monthly-resolution-statement.png"), fullPage: true });
  } finally {
    // Only this disposable fixture is removed, after normal immutable-event
    // enforcement was exercised. The override cannot escape this transaction
    // or affect the application's separate connections.
    const cleanup = await pool.connect();
    try {
      await cleanup.query("BEGIN");
      await cleanup.query("SET LOCAL session_replication_role = replica");
      await cleanup.query(`DELETE FROM settlement_batches WHERE id IN (SELECT settlement_batch_id FROM settlement_events WHERE individual_id=$1)`, [individualId]);
      await cleanup.query(`DELETE FROM settlement_events WHERE individual_id=$1`, [individualId]);
      await cleanup.query(`DELETE FROM settlement_obligations WHERE individual_id=$1`, [individualId]);
      await cleanup.query(`DELETE FROM calculation_strategy_revisions WHERE strategy_id=$1`, [strategyId]);
      await cleanup.query(`DELETE FROM calculation_strategy_lines WHERE strategy_id=$1`, [strategyId]);
      await cleanup.query(`DELETE FROM calculation_strategies WHERE individual_id=$1`, [individualId]);
      await cleanup.query(`DELETE FROM individuals WHERE id=$1`, [individualId]);
      await cleanup.query("COMMIT");
    } catch (error) {
      await cleanup.query("ROLLBACK");
      throw error;
    } finally { cleanup.release(); }
    await pool.end();
  }
});
