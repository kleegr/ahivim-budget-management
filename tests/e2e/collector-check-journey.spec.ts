import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { EXPECTED_DISPOSABLE_DB_HOST, RESET_CONFIRMATION, REPRESENTATIVE_ACCOUNTS, TEST_DB_URL, assertSafeE2eDatabaseReset, passwordFor, type RepresentativeAccount } from "./fixtures";

const owner = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "owner")!;
const collector = REPRESENTATIVE_ACCOUNTS.find((account) => account.preset === "money_collector")!;
const DATE = "2026-08-04";
const MONTH = "2026-08";

async function signIn(page: Page, account: RepresentativeAccount) {
  await page.context().clearCookies();
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(passwordFor(account));
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.pathname === account.expectedPath);
}

async function post(page: Page, path: string, data: Record<string, unknown>) {
  const response = await page.request.post(path, { data });
  const body = await response.json();
  expect(response.ok(), `${path}: ${JSON.stringify(body)}`).toBe(true);
  expect(body.ok).toBe(true);
  return body.data;
}

test("Owner verifies check evidence and agreement, then Money Collector completes append-only collection while another source stays held", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  assertSafeE2eDatabaseReset({ connectionString: TEST_DB_URL, expectedHost: EXPECTED_DISPOSABLE_DB_HOST, confirmation: RESET_CONFIRMATION });
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 2 });
  const suffix = randomUUID().slice(0, 8);
  const individualId = randomUUID();
  const subjects = ["Reviewed", "Held"].map((label) => ({
    employeeId: randomUUID(), transactionId: randomUUID(), checkId: "",
    name: `Collector ${label} ${suffix}`, checkNumber: `COLLECTOR-${label}-${suffix}`,
  }));
  const [reviewed, held] = subjects;
  const employeeIds = subjects.map((subject) => subject.employeeId);
  const path = `/settlements?queue=all&employeeId=${reviewed!.employeeId}`;
  const proof = `Synthetic payroll proof ${suffix}: gross300, net240, withheld60`;
  const refs = { original: `COLLECT-${suffix}-ORIGINAL`, corrected: `COLLECT-${suffix}-CORRECTED`, extra: `COLLECT-${suffix}-EXTRA`, refund: `COLLECT-${suffix}-REFUND` };
  let seeded = false;

  async function events() {
    return (await pool.query<{
      id: string; event_type: string; amount: string; reference: string | null;
      reversal_of_event_id: string | null; created_by_user_id: string; occurred_on: string;
    }>(`SELECT id,event_type,amount::numeric(14,2)::text AS amount,reference,
        reversal_of_event_id,created_by_user_id,occurred_on::text FROM settlement_events
        WHERE employee_id=$1 ORDER BY created_at,id`, [reviewed!.employeeId])).rows;
  }
  async function assertHeld() {
    expect((await pool.query("SELECT verification_status FROM employee_payroll_checks WHERE id=$1", [held!.checkId])).rows[0]?.verification_status).toBe("unverified");
    expect((await pool.query("SELECT id FROM settlement_obligations WHERE employee_id=$1 AND status='active'", [held!.employeeId])).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM settlement_events WHERE employee_id=$1", [held!.employeeId])).rows).toEqual([]);
  }
  async function openItem(balance: string) {
    await page.goto(path);
    const row = page.getByRole("table", { name: "Payment obligations and current balances" }).getByRole("row").filter({ hasText: reviewed!.name });
    await expect(row).toContainText(balance);
    return row;
  }
  async function payment(amount: string, reference: string, balance: string, credit?: string) {
    await (await openItem(balance)).getByRole("button", { name: "Record amount", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Record amount - ${reviewed!.name}` });
    await dialog.getByLabel("Amount received").fill(amount);
    if (credit) await expect(dialog.getByText(`This creates a credit of $${credit}.`, { exact: true })).toBeVisible();
    await dialog.getByLabel("Date", { exact: true }).fill(DATE);
    await dialog.getByLabel(/^Reference/).fill(reference);
    await dialog.getByRole("button", { name: "Record amount", exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  async function openHistory() {
    await page.goto(path);
    await page.getByRole("tab", { name: /History/ }).click();
    return page.getByRole("table", { name: "Complete payment and reversal history" });
  }

  try {
    // Seed only imported source facts. Every check review, agreement and money
    // entry below goes through the real application; no obligation is seeded.
    await pool.query("INSERT INTO individuals(id,normalized_name,display_name) VALUES($1,$2,$2)", [individualId, `Collector person ${suffix}`]);
    seeded = true;
    const programId = (await pool.query("SELECT id FROM programs WHERE code='COM_HAB' LIMIT 1")).rows[0]!.id;
    for (const subject of subjects) {
      await pool.query("INSERT INTO employees(id,normalized_name,display_name) VALUES($1,$2,$2)", [subject.employeeId, subject.name]);
      await pool.query(`INSERT INTO payroll_transactions(id,source_row_number,check_number,check_date,period_begin,period_end,
        individual_id,employee_id,program_id,individual_raw,employee_raw,program_raw,imported_hours,imported_rate,
        imported_amount,total_net_pay,spreadsheet_internal_amount,calculated_internal_amount,internal_rate_applied,
        agency_rate_applied,employee_payment_amount,payment_recipient,pay_to_raw,transaction_fingerprint)
        VALUES($1,1,$2,$3,'2026-08-01','2026-08-03',$4,$5,$6,$7,$8,'COM_HAB',10,30,300,240,240,240,24,30,240,'employee',$8,$9)`,
      [subject.transactionId, subject.checkNumber, DATE, individualId, subject.employeeId, programId, `Collector person ${suffix}`, subject.name, `collector-${subject.transactionId}`]);
    }
    await signIn(page, owner);
    for (const subject of subjects) {
      const check = await post(page, "/api/payroll-checks", {
        employeeId: subject.employeeId, checkNumber: subject.checkNumber, checkDate: DATE,
        periodBegin: "2026-08-01", periodEnd: "2026-08-03", actualGross: "300", actualNet: "240",
        verificationStatus: "unverified", sourceRef: "Imported amount awaiting proof review",
        sourceTransactionIds: [subject.transactionId],
      });
      subject.checkId = check.id;
    }
    await post(page, "/api/employee-deals", {
      employeeId: held!.employeeId, directRule: "giveback_percent", directPercent: "10",
      effectiveFrom: "2026-08-01", reason: "Agreement exists but this independent check still lacks verified proof",
    });
    expect((await pool.query("SELECT id FROM settlement_obligations WHERE employee_id=ANY($1::uuid[])", [employeeIds])).rows).toEqual([]);

    // Before verification there is no collectible item. A collector can work
    // payroll checks but cannot change the manager-owned employee agreement.
    await signIn(page, collector);
    expect((await page.request.post("/api/employee-deals", { data: { employeeId: reviewed!.employeeId, directRule: "giveback_all", effectiveFrom: "2026-08-01", reason: "Unauthorized collector edit" } })).status()).toBe(403);
    await page.goto(path);
    await expect(page.getByRole("button", { name: "Record amount", exact: true })).toHaveCount(0);

    await signIn(page, owner);
    await page.goto(`/employees/${reviewed!.employeeId}?view=deal`);
    await page.getByRole("button", { name: "Set deal", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Set employee deal" });
    await dialog.getByRole("combobox", { name: "When paid directly", exact: true }).selectOption("giveback_percent");
    await dialog.getByLabel("Direct give-back %", { exact: false }).fill("10");
    await dialog.getByLabel("Starts on", { exact: true }).fill("2026-08-01");
    await dialog.getByLabel("Reason for change").fill(`Reviewed employee agreement ${suffix}`);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect((await pool.query("SELECT id FROM settlement_obligations WHERE employee_id=$1 AND status='active'", [reviewed!.employeeId])).rows).toEqual([]);

    await page.goto(`/masser?view=checks&month=${MONTH}&focusCheckId=${reviewed!.checkId}`);
    const checkRow = page.locator(`#payroll-check-${reviewed!.checkId}`);
    await expect(checkRow).toContainText("Needs review");
    await checkRow.getByRole("button", { name: "Edit payroll check" }).click();
    const form = page.locator("form").filter({ has: page.getByLabel("Source reference", { exact: true }) });
    await expect(form.getByLabel("Actual gross", { exact: true })).toHaveValue("300.0000");
    await expect(form.getByLabel("Actual net", { exact: true })).toHaveValue("240.0000");
    await form.getByLabel("Source reference", { exact: true }).fill(proof);
    await form.getByRole("button", { name: "Update check", exact: true }).click();
    await expect(form).toBeHidden();
    await page.reload();
    await checkRow.getByRole("button", { name: "Verify check", exact: true }).click();
    await expect(page.getByText("Check facts verified with 1 linked service. Review money operations for collection eligibility and amounts.", { exact: true })).toBeVisible();
    await page.goto(path);
    await page.getByRole("button", { name: "Refresh items", exact: true }).click();
    await expect(page.getByRole("button", { name: "Refresh items", exact: true })).toBeEnabled();
    await openItem("$24.00");
    const ownerId = (await pool.query("SELECT id FROM users WHERE email=$1", [owner.email])).rows[0]!.id;
    expect((await pool.query("SELECT verification_status,source_ref,updated_by_user_id FROM employee_payroll_checks WHERE id=$1", [reviewed!.checkId])).rows[0]).toMatchObject({ verification_status: "verified", source_ref: proof, updated_by_user_id: ownerId });
    const obligations = (await pool.query("SELECT id,original_amount::numeric(14,2)::text AS amount,employee_deal_id FROM settlement_obligations WHERE employee_id=$1 AND status='active'", [reviewed!.employeeId])).rows;
    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toMatchObject({ amount: "24.00", employee_deal_id: expect.any(String) });
    expect((await pool.query("SELECT payroll_transaction_id FROM settlement_obligation_transactions WHERE settlement_obligation_id=$1", [obligations[0]!.id])).rows).toEqual([{ payroll_transaction_id: reviewed!.transactionId }]);
    await assertHeld();

    await signIn(page, collector);
    await payment("10", refs.original, "$24.00");
    await openItem("$14.00");
    const original = (await events())[0]!;
    await (await openHistory()).getByRole("row").filter({ hasText: refs.original }).getByRole("button", { name: "Correct", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Correct payment entry" });
    await dialog.getByLabel("Corrected amount").fill("12");
    await dialog.getByLabel("Corrected date").fill(DATE);
    await dialog.getByLabel(/^Reference/).fill(refs.corrected);
    await dialog.getByLabel("Correction reason").fill("Receipt shows twelve, original ten retained");
    await dialog.getByRole("button", { name: "Save correction", exact: true }).click();
    await expect(dialog).toBeHidden();
    await payment("20", refs.extra, "$12.00", "8.00");
    await page.setViewportSize({ width: 390, height: 844 });
    await (await openItem("-$8.00")).getByRole("button", { name: "Refund", exact: true }).click();
    dialog = page.getByRole("dialog", { name: `Record credit refund - ${reviewed!.name}` });
    await dialog.getByLabel("Amount refunded").fill("8");
    await dialog.getByLabel("Date", { exact: true }).fill(DATE);
    await dialog.getByLabel(/^Reference/).fill(refs.refund);
    await dialog.getByRole("button", { name: "Record refund", exact: true }).click();
    await expect(dialog).toBeHidden();
    await openItem("$0.00");
    await (await openHistory()).getByRole("row").filter({ hasText: refs.refund }).getByRole("button", { name: "Reverse", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Reverse money entry" });
    await dialog.getByLabel("Reason", { exact: true }).fill("Refund was not delivered; restore the employee credit");
    await dialog.getByRole("button", { name: "Reverse entry", exact: true }).click();
    await expect(dialog).toBeHidden();
    await openItem("-$8.00");

    const finalEvents = await events();
    expect(finalEvents).toHaveLength(6);
    expect(finalEvents.find((event) => event.id === original.id)).toMatchObject({ amount: "10.00", reference: refs.original });
    expect(finalEvents.find((event) => event.reversal_of_event_id === original.id)).toMatchObject({ event_type: "reversal", amount: "-10.00" });
    expect(finalEvents.map((event) => Number(event.amount)).reduce((sum, amount) => sum + amount, 0)).toBe(32);
    const collectorId = (await pool.query("SELECT id FROM users WHERE email=$1", [collector.email])).rows[0]!.id;
    expect(new Set(finalEvents.map((event) => event.created_by_user_id))).toEqual(new Set([collectorId]));
    const history = await openHistory();
    await expect(history.getByRole("row").filter({ hasText: refs.original })).toContainText("Reversed");
    await expect(history.getByRole("row").filter({ hasText: refs.corrected })).toContainText("Corrected payment");
    await expect(history.getByRole("row").filter({ hasText: refs.refund })).toContainText("Reversed");
    await testInfo.attach("collector-phone-auditable-history", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await page.goto(`/masser?month=${MONTH}`);
    const statementRow = page.getByRole("row").filter({ hasText: reviewed!.name });
    await expect(statementRow).toContainText("$24.00");
    // A reversal is posted today, preserving the original month. The selected
    // month's cash activity can differ from the all-time32 applied above.
    const monthlyCollected = finalEvents.filter((event) => event.occurred_on.startsWith(MONTH))
      .reduce((sum, event) => sum + Number(event.amount), 0);
    await expect(statementRow.getByRole("cell").nth(2)).toHaveText(`$${monthlyCollected.toFixed(2)}`);
    await expect(statementRow).toContainText("$8.00");
    await assertHeld();
    await page.goto(`/settlements?queue=all&employeeId=${held!.employeeId}`);
    await expect(page.getByRole("button", { name: "Record amount", exact: true })).toHaveCount(0);
  } finally {
    try {
      if (seeded) {
        // Cleanup is restricted to this test's UUIDs on the independently
        // confirmed disposable DB. The transaction-local setting never affects
        // the application connection or the immutable-history assertions above.
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL session_replication_role = replica");
          const batches = (await client.query("SELECT DISTINCT settlement_batch_id AS id FROM settlement_events WHERE employee_id=ANY($1::uuid[])", [employeeIds])).rows.map((row) => row.id).filter(Boolean);
          await client.query("DELETE FROM settlement_events WHERE employee_id=ANY($1::uuid[])", [employeeIds]);
          await client.query("DELETE FROM settlement_obligation_transactions WHERE settlement_obligation_id IN (SELECT id FROM settlement_obligations WHERE employee_id=ANY($1::uuid[]))", [employeeIds]);
          await client.query("DELETE FROM settlement_obligations WHERE employee_id=ANY($1::uuid[])", [employeeIds]);
          await client.query("DELETE FROM payroll_transactions WHERE employee_id=ANY($1::uuid[])", [employeeIds]);
          await client.query("DELETE FROM employee_payroll_checks WHERE employee_id=ANY($1::uuid[])", [employeeIds]);
          await client.query("DELETE FROM employee_deal_revisions WHERE employee_deal_id IN (SELECT id FROM employee_deals WHERE employee_id=ANY($1::uuid[]))", [employeeIds]);
          await client.query("DELETE FROM employee_deals WHERE employee_id=ANY($1::uuid[])", [employeeIds]);
          await client.query("DELETE FROM employees WHERE id=ANY($1::uuid[])", [employeeIds]);
          await client.query("DELETE FROM individuals WHERE id=$1", [individualId]);
          if (batches.length) await client.query("DELETE FROM settlement_batches WHERE id=ANY($1::uuid[])", [batches]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally { client.release(); }
        expect((await pool.query("SHOW session_replication_role")).rows[0]?.session_replication_role).toBe("origin");
        expect((await pool.query("SELECT id FROM employees WHERE id=ANY($1::uuid[])", [employeeIds])).rows).toEqual([]);
      }
    } finally { await pool.end(); }
  }
});
