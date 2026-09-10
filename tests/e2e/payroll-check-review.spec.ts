import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { EXPECTED_DISPOSABLE_DB_HOST, RESET_CONFIRMATION, REPRESENTATIVE_ACCOUNTS, TEST_DB_URL, assertSafeE2eDatabaseReset, passwordFor } from "./fixtures";

test("check review searches every page, recovers an invalid edit, and retains verified facts without inventing a collection", async ({ page }) => {
  test.setTimeout(180_000);
  assertSafeE2eDatabaseReset({ connectionString: TEST_DB_URL, expectedHost: EXPECTED_DISPOSABLE_DB_HOST, confirmation: RESET_CONFIRMATION });
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 2 });
  const employeeId = randomUUID();
  const name = `Check review ${randomUUID().slice(0, 8)}`;
  const proof = `Reviewed source reference ${employeeId}`;
  const owner = REPRESENTATIVE_ACCOUNTS.find(account => account.preset === "owner")!;
  try {
    await pool.query("INSERT INTO employees(id,normalized_name,display_name) VALUES($1,$2,$2)", [employeeId, name]);
    // Synthetic check facts only, on the independently confirmed disposable DB.
    await pool.query(`INSERT INTO employee_payroll_checks(employee_id,check_number,check_date,actual_gross,actual_net,verification_status)
      SELECT $1::uuid,'REVIEW-' || n,'2026-09-01',100,80,'unverified' FROM generate_series(1,105) n`, [employeeId]);
    await page.goto("/signin");
    await page.getByLabel("Email address").fill(owner.email);
    await page.getByLabel("Password", { exact: true }).fill(passwordFor(owner));
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL(url => url.pathname === owner.expectedPath);
    await page.goto("/masser?view=checks&month=2026-09");
    await page.getByLabel("Search checks", { exact: true }).fill(name);
    await page.getByLabel("Check status", { exact: true }).selectOption("unverified");
    await page.getByRole("button", { name: "Search checks", exact: true }).click();
    await expect(page.getByText("Showing 1–50 of 105 matching checks.", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "Next checks", exact: true }).click();
    await expect(page.getByText("Showing 51–100 of 105 matching checks.", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "Next checks", exact: true }).click();
    await expect(page.getByText("Showing 101–105 of 105 matching checks.", { exact: false })).toBeVisible();
    const table = page.getByRole("table", { name: "Payroll checks", exact: true });
    const rowId = await table.locator("tbody tr").first().getAttribute("id");
    expect(rowId).toBeTruthy();
    const row = page.locator(`#${rowId}`);
    const checkId = rowId!.replace("payroll-check-", "");
    await row.getByRole("button", { name: "Edit payroll check", exact: true }).click();
    const form = page.locator("form").filter({ has: page.getByLabel("Source reference", { exact: true }) });
    await form.getByLabel("Source reference", { exact: true }).fill(proof);
    await form.getByLabel("Actual gross", { exact: true }).fill("70");
    await form.getByRole("button", { name: "Update check", exact: true }).click();
    await expect(form.getByText("Gross, net, and tax/withholding must be valid non-negative amounts, and gross cannot be below net.", { exact: true })).toBeVisible();
    await expect(form.getByLabel("Source reference", { exact: true })).toHaveValue(proof);
    await form.getByLabel("Actual gross", { exact: true }).fill("100");
    await form.getByRole("button", { name: "Update check", exact: true }).click();
    await expect(form).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`savedCheckId=${checkId}`));
    await page.reload();
    await row.getByRole("button", { name: "Edit payroll check", exact: true }).click();
    await expect(form.getByLabel("Source reference", { exact: true })).toHaveValue(proof);
    await expect(form.getByLabel("Actual gross", { exact: true })).toHaveValue("100.0000");
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await row.getByRole("button", { name: "Verify check", exact: true }).click();
    await expect(page.getByText("Check facts verified. No linked services were found, so no collection amount was created from this check. Review the employee's billed activity.", { exact: true })).toBeVisible();
    await expect(row).toContainText("verified");
    await expect(row).toContainText("No linked services");
    await expect(row.getByRole("button", { name: "Verify check", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(row).toContainText("verified");
    await expect(page.getByText("Your saved check is kept at the top", { exact: false })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel("Search checks", { exact: true })).toBeVisible();
    await row.getByRole("link", { name: "Review employee services", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`employeeId=${employeeId}`));
    expect((await pool.query("SELECT verification_status,source_ref FROM employee_payroll_checks WHERE id=$1", [checkId])).rows[0])
      .toMatchObject({ verification_status: "verified", source_ref: proof });
    expect((await pool.query("SELECT id FROM settlement_obligations WHERE employee_id=$1", [employeeId])).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM settlement_events WHERE employee_id=$1", [employeeId])).rows).toEqual([]);
  } finally {
    await pool.query("DELETE FROM employee_payroll_checks WHERE employee_id=$1", [employeeId]);
    await pool.query("DELETE FROM employees WHERE id=$1", [employeeId]);
    await pool.end();
  }
});
