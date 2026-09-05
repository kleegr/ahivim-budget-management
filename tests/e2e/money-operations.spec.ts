import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  TEST_DB_URL,
} from "./fixtures";
import {
  MONEY_REPORT_AGENCY_SHARE,
  MONEY_REPORT_GROSS,
  MONEY_REPORT_INDIVIDUAL_SHARE,
  MONEY_REPORT_INVOICE_NUMBER,
  MONEY_REPORT_MONTH,
  MONEY_REPORT_RECEIPT_REFERENCE,
  MONEY_REPORT_TOTAL_INCOME,
  MONEY_RESERVE_INDIVIDUAL_ID,
  MONEY_RESERVE_INDIVIDUAL_NAME,
  MONEY_RESERVE_OBLIGATION_ID,
  MONEY_WORKFLOW_DATE,
  MONEY_WORKFLOW_EMPLOYEE_ID,
  MONEY_WORKFLOW_EMPLOYEE_NAME,
  MONEY_WORKFLOW_OBLIGATION_ID,
} from "./money-operations-fixtures";

const ORIGINAL_PAYMENT_REFERENCE = "E2E-PAYMENT-ORIGINAL";
const CORRECTED_PAYMENT_REFERENCE = "E2E-PAYMENT-CORRECTED";
const OVERPAYMENT_REFERENCE = "E2E-PAYMENT-CREDIT";
const REFUND_REFERENCE = "E2E-CREDIT-REFUND";
const RESERVE_REFERENCE = "E2E-RESERVE-OVERAGE";
const RELEASE_REFERENCE = "E2E-RESERVE-RELEASE";
const CORRECTION_REASON = "The deposited amount was entered from the wrong receipt.";

interface MoneyEventRow {
  id: string;
  event_type: "payment" | "set_aside" | "credit" | "adjustment" | "reversal";
  amount: string;
  reference: string | null;
  note: string | null;
  reversal_of_event_id: string | null;
  batch_id: string | null;
  batch_action: string | null;
  idempotency_key: string | null;
}

interface LostResponseController {
  firstRequestStarted: Promise<void>;
  releaseFirstResponse: () => void;
  requestBodies: Array<Record<string, unknown>>;
  upstreamStatuses: number[];
  stop: () => Promise<void>;
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 20_000 });
}

async function moneyEvents(
  pool: Pool,
  obligationId = MONEY_WORKFLOW_OBLIGATION_ID,
): Promise<MoneyEventRow[]> {
  const result = await pool.query<MoneyEventRow>(
    `SELECT event.id, event.event_type,
            event.amount::numeric(14, 2)::text AS amount,
            event.reference, event.note, event.reversal_of_event_id,
            batch.id AS batch_id, batch.action AS batch_action,
            batch.idempotency_key::text AS idempotency_key
       FROM settlement_events event
       LEFT JOIN settlement_batches batch ON batch.id = event.settlement_batch_id
      WHERE event.settlement_obligation_id = $1
      ORDER BY event.created_at, event.id`,
    [obligationId],
  );
  return result.rows;
}

async function simulateLostResponseOnce(
  page: Page,
  url: string,
  accepts: (body: Record<string, unknown>) => boolean = () => true,
): Promise<LostResponseController> {
  let markFirstRequestStarted!: () => void;
  let releaseFirstResponse!: () => void;
  const firstRequestStarted = new Promise<void>((resolve) => {
    markFirstRequestStarted = resolve;
  });
  const firstResponseReleased = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  const requestBodies: Array<Record<string, unknown>> = [];
  const upstreamStatuses: number[] = [];

  await page.route(url, async (route) => {
    const candidate = route.request().postDataJSON() as unknown;
    const body = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : {};
    if (!accepts(body)) {
      await route.continue();
      return;
    }

    requestBodies.push(body);
    if (requestBodies.length === 1) {
      markFirstRequestStarted();
      await firstResponseReleased;
      const upstream = await route.fetch();
      upstreamStatuses.push(upstream.status());
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Simulated lost response after commit." }),
      });
      return;
    }

    const upstream = await route.fetch();
    upstreamStatuses.push(upstream.status());
    await route.fulfill({ response: upstream });
  });

  return {
    firstRequestStarted,
    releaseFirstResponse,
    requestBodies,
    upstreamStatuses,
    stop: () => page.unroute(url),
  };
}

function expectSameOperationKey(bodies: Array<Record<string, unknown>>): void {
  expect(bodies).toHaveLength(2);
  const keys = bodies.map((body) => body.operationKey);
  expect(keys[0]).toEqual(expect.any(String));
  expect(String(keys[0])).toMatch(/^[0-9a-f-]{36}$/i);
  expect(keys[1]).toBe(keys[0]);
}

test.describe.serial("append-only Money operations", () => {
  let pool: Pool;

  test.beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DB_URL, max: 2 });
  });

  test.afterAll(async () => {
    await pool.end();
  });

  test("correction and credit refund survive a lost response without duplicating history", async ({ page }) => {
    await signIn(page);
    const settlementPath = `/settlements?queue=all&employeeId=${MONEY_WORKFLOW_EMPLOYEE_ID}`;
    const response = await page.goto(settlementPath);
    expect(response?.status()).toBe(200);
    const main = page.locator("#main");
    await expect(main.getByRole("heading", { level: 1, name: "Money operations" })).toBeVisible();

    const items = main.getByRole("table", { name: "Payment obligations and current balances" });
    let itemRow = items.getByRole("row").filter({ hasText: MONEY_WORKFLOW_EMPLOYEE_NAME });
    await expect(itemRow).toContainText("$24.00");
    await itemRow.getByRole("button", { name: "Record amount" }).click();
    let dialog = page.getByRole("dialog", {
      name: `Record amount - ${MONEY_WORKFLOW_EMPLOYEE_NAME}`,
    });
    await dialog.getByLabel("Amount received").fill("10.00");
    await dialog.getByLabel("Date").fill(MONEY_WORKFLOW_DATE);
    await dialog.getByLabel(/^Reference/).fill(ORIGINAL_PAYMENT_REFERENCE);
    await dialog.getByLabel(/^Note/).fill("Original receipt retained for correction acceptance");
    await dialog.getByRole("button", { name: "Record amount" }).click();
    await expect(main.getByRole("status").filter({
      hasText: `Recorded $10.00 for ${MONEY_WORKFLOW_EMPLOYEE_NAME}.`,
    })).toBeVisible();

    const initialEvents = await moneyEvents(pool);
    expect(initialEvents).toHaveLength(1);
    const original = initialEvents[0]!;
    expect(original).toMatchObject({
      event_type: "payment",
      amount: "10.00",
      reference: ORIGINAL_PAYMENT_REFERENCE,
      reversal_of_event_id: null,
      batch_action: "payment",
    });

    await page.goto(settlementPath);
    await main.getByRole("tab", { name: /History/ }).click();
    const history = main.getByRole("table", { name: "Complete payment and reversal history" });
    const originalHistoryRow = history.getByRole("row").filter({ hasText: ORIGINAL_PAYMENT_REFERENCE });
    await expect(originalHistoryRow).toContainText("Payment");
    await originalHistoryRow.getByRole("button", { name: "Correct" }).click();

    dialog = page.getByRole("dialog", { name: "Correct payment entry" });
    await dialog.getByLabel("Corrected amount").fill("12.00");
    await dialog.getByLabel("Corrected date").fill(MONEY_WORKFLOW_DATE);
    await dialog.getByLabel(/^Reference/).fill(CORRECTED_PAYMENT_REFERENCE);
    await dialog.getByLabel(/^Note/).fill("Corrected receipt value");
    await dialog.getByLabel("Correction reason").fill(CORRECTION_REASON);

    const correctionUrl = `**/api/settlements/events/${original.id}/correct`;
    const correctionRetry = await simulateLostResponseOnce(page, correctionUrl);
    const firstCorrectionClick = dialog.getByRole("button", { name: "Save correction" }).click();
    await correctionRetry.firstRequestStarted;
    await expect(dialog.getByRole("button", { name: "Correcting..." })).toBeDisabled();
    correctionRetry.releaseFirstResponse();
    await firstCorrectionClick;
    await expect(dialog.getByRole("alert")).toContainText("Simulated lost response after commit.");
    await expect(dialog.getByRole("button", { name: "Save correction" })).toBeEnabled();
    expect(correctionRetry.upstreamStatuses).toEqual([200]);

    const afterLostCorrection = await moneyEvents(pool);
    expect(afterLostCorrection).toHaveLength(3);
    expect(afterLostCorrection.find((event) => event.id === original.id)).toMatchObject({
      event_type: "payment",
      amount: "10.00",
      reference: ORIGINAL_PAYMENT_REFERENCE,
    });
    const correctionEvents = afterLostCorrection.filter((event) => event.batch_action === "correct_event");
    expect(correctionEvents).toHaveLength(2);
    expect(new Set(correctionEvents.map((event) => event.batch_id)).size).toBe(1);
    expect(correctionEvents.find((event) => event.event_type === "reversal")).toMatchObject({
      amount: "-10.00",
      note: CORRECTION_REASON,
      reversal_of_event_id: original.id,
    });
    expect(correctionEvents.find((event) => event.event_type === "payment")).toMatchObject({
      amount: "12.00",
      reference: CORRECTED_PAYMENT_REFERENCE,
      note: "Corrected receipt value",
      reversal_of_event_id: null,
    });

    await dialog.getByRole("button", { name: "Save correction" }).click();
    await expect(dialog).toBeHidden();
    await expect(main.getByRole("status").filter({
      hasText: `Corrected the entry for ${MONEY_WORKFLOW_EMPLOYEE_NAME} to $12.00.`,
    })).toBeVisible();
    expectSameOperationKey(correctionRetry.requestBodies);
    expect(correctionRetry.upstreamStatuses).toEqual([200, 200]);
    await correctionRetry.stop();
    expect((await moneyEvents(pool)).map((event) => event.id).sort()).toEqual(
      afterLostCorrection.map((event) => event.id).sort(),
    );

    await page.goto(settlementPath);
    itemRow = main
      .getByRole("table", { name: "Payment obligations and current balances" })
      .getByRole("row")
      .filter({ hasText: MONEY_WORKFLOW_EMPLOYEE_NAME });
    await expect(itemRow).toContainText("$12.00");
    await itemRow.getByRole("button", { name: "Record amount" }).click();
    dialog = page.getByRole("dialog", {
      name: `Record amount - ${MONEY_WORKFLOW_EMPLOYEE_NAME}`,
    });
    await dialog.getByLabel("Amount received").fill("20.00");
    await expect(dialog.getByText("This creates a credit of $8.00.")).toBeVisible();
    await dialog.getByLabel("Date").fill(MONEY_WORKFLOW_DATE);
    await dialog.getByLabel(/^Reference/).fill(OVERPAYMENT_REFERENCE);
    await dialog.getByLabel(/^Note/).fill("Overpayment creates the disposable test credit");
    await dialog.getByRole("button", { name: "Record amount" }).click();
    await expect(main.getByRole("status").filter({
      hasText: `Recorded $20.00 for ${MONEY_WORKFLOW_EMPLOYEE_NAME}.`,
    })).toBeVisible();

    const beforeRefund = await moneyEvents(pool);
    expect(beforeRefund).toHaveLength(4);
    expect(beforeRefund.find((event) => event.reference === OVERPAYMENT_REFERENCE)).toMatchObject({
      event_type: "payment",
      amount: "20.00",
    });

    await page.goto(settlementPath);
    itemRow = main
      .getByRole("table", { name: "Payment obligations and current balances" })
      .getByRole("row")
      .filter({ hasText: MONEY_WORKFLOW_EMPLOYEE_NAME });
    await expect(itemRow).toContainText("-$8.00");
    await itemRow.getByRole("button", { name: "Refund" }).click();
    dialog = page.getByRole("dialog", {
      name: `Record credit refund - ${MONEY_WORKFLOW_EMPLOYEE_NAME}`,
    });
    await dialog.getByLabel("Amount refunded").fill("8.00");
    await dialog.getByLabel("Date").fill(MONEY_WORKFLOW_DATE);
    await dialog.getByLabel(/^Reference/).fill(REFUND_REFERENCE);
    await dialog.getByLabel(/^Note/).fill("Return the exact available credit");

    const refundUrl = "**/api/settlements/events";
    const refundRetry = await simulateLostResponseOnce(
      page,
      refundUrl,
      (body) => body.action === "refund",
    );
    const firstRefundClick = dialog.getByRole("button", { name: "Record refund" }).click();
    await refundRetry.firstRequestStarted;
    await expect(dialog.getByRole("button", { name: "Recording..." })).toBeDisabled();
    refundRetry.releaseFirstResponse();
    await firstRefundClick;
    await expect(dialog.getByRole("alert")).toContainText("Simulated lost response after commit.");
    await expect(dialog.getByRole("button", { name: "Record refund" })).toBeEnabled();
    expect(refundRetry.upstreamStatuses).toEqual([200]);

    const afterLostRefund = await moneyEvents(pool);
    expect(afterLostRefund).toHaveLength(5);
    expect(afterLostRefund.filter((event) => event.batch_action === "refund_credit")).toEqual([
      expect.objectContaining({
        event_type: "adjustment",
        amount: "-8.00",
        reference: REFUND_REFERENCE,
        note: "Return the exact available credit",
      }),
    ]);
    expect(afterLostRefund.find((event) => event.id === original.id)).toBeDefined();
    expect(afterLostRefund.filter((event) => event.batch_action === "correct_event")).toHaveLength(2);

    await dialog.getByRole("button", { name: "Record refund" }).click();
    await expect(dialog).toBeHidden();
    await expect(main.getByRole("status").filter({
      hasText: `Refunded $8.00 for ${MONEY_WORKFLOW_EMPLOYEE_NAME}.`,
    })).toBeVisible();
    expectSameOperationKey(refundRetry.requestBodies);
    expect(refundRetry.upstreamStatuses).toEqual([200, 200]);
    await refundRetry.stop();
    expect((await moneyEvents(pool)).map((event) => event.id).sort()).toEqual(
      afterLostRefund.map((event) => event.id).sort(),
    );

    await page.goto(settlementPath);
    await main.getByRole("tab", { name: /History/ }).click();
    const finalHistory = main.getByRole("table", { name: "Complete payment and reversal history" });
    await expect(finalHistory.getByRole("row").filter({ hasText: ORIGINAL_PAYMENT_REFERENCE })).toContainText("Reversed");
    await expect(finalHistory.getByRole("row").filter({ hasText: CORRECTED_PAYMENT_REFERENCE })).toContainText("Corrected payment");
    await expect(finalHistory.getByRole("row").filter({ hasText: CORRECTION_REASON })).toContainText("Reversal");
    await expect(finalHistory.getByRole("row").filter({ hasText: REFUND_REFERENCE })).toContainText("Credit refunded / released");
  });

  test("an individual put-away credit is released as one append-only adjustment", async ({ page }) => {
    await signIn(page);
    const settlementPath = `/settlements?queue=all&individualId=${MONEY_RESERVE_INDIVIDUAL_ID}`;
    const response = await page.goto(settlementPath);
    expect(response?.status()).toBe(200);
    const main = page.locator("#main");
    await expect(main.getByRole("heading", { level: 1, name: "Money operations" })).toBeVisible();

    let itemRow = main
      .getByRole("table", { name: "Payment obligations and current balances" })
      .getByRole("row")
      .filter({ hasText: MONEY_RESERVE_INDIVIDUAL_NAME });
    await expect(itemRow).toContainText("$15.00");
    await itemRow.getByRole("button", { name: "Record amount" }).click();
    let dialog = page.getByRole("dialog", {
      name: `Record amount - ${MONEY_RESERVE_INDIVIDUAL_NAME}`,
    });
    await dialog.getByLabel("Amount set aside").fill("20.00");
    await expect(dialog.getByText("This creates a credit of $5.00.")).toBeVisible();
    await dialog.getByLabel("Date").fill(MONEY_WORKFLOW_DATE);
    await dialog.getByLabel(/^Reference/).fill(RESERVE_REFERENCE);
    await dialog.getByLabel(/^Note/).fill("Put-away above the approved target");
    await dialog.getByRole("button", { name: "Record amount" }).click();
    await expect(main.getByRole("status").filter({
      hasText: `Recorded $20.00 for ${MONEY_RESERVE_INDIVIDUAL_NAME}.`,
    })).toBeVisible();

    const beforeRelease = await moneyEvents(pool, MONEY_RESERVE_OBLIGATION_ID);
    expect(beforeRelease).toHaveLength(1);
    const originalSetAside = beforeRelease[0]!;
    expect(originalSetAside).toMatchObject({
      event_type: "set_aside",
      amount: "20.00",
      reference: RESERVE_REFERENCE,
      reversal_of_event_id: null,
      batch_action: "payment",
    });

    await page.goto(settlementPath);
    itemRow = main
      .getByRole("table", { name: "Payment obligations and current balances" })
      .getByRole("row")
      .filter({ hasText: MONEY_RESERVE_INDIVIDUAL_NAME });
    await expect(itemRow).toContainText("-$5.00");
    await itemRow.getByRole("button", { name: "Release" }).click();
    dialog = page.getByRole("dialog", {
      name: `Release excess reserve - ${MONEY_RESERVE_INDIVIDUAL_NAME}`,
    });
    await expect(dialog.getByText(/keeps the original activity and appends this adjustment/)).toBeVisible();
    await dialog.getByLabel("Amount released").fill("5.00");
    await dialog.getByLabel("Date").fill(MONEY_WORKFLOW_DATE);
    await dialog.getByLabel(/^Reference/).fill(RELEASE_REFERENCE);
    await dialog.getByLabel(/^Note/).fill("Release only the excess put-away");

    const releaseUrl = "**/api/settlements/events";
    const releaseRetry = await simulateLostResponseOnce(
      page,
      releaseUrl,
      (body) => body.action === "refund",
    );
    const firstReleaseClick = dialog.getByRole("button", { name: "Release reserve" }).click();
    await releaseRetry.firstRequestStarted;
    await expect(dialog.getByRole("button", { name: "Recording..." })).toBeDisabled();
    releaseRetry.releaseFirstResponse();
    await firstReleaseClick;
    await expect(dialog.getByRole("alert")).toContainText("Simulated lost response after commit.");
    await expect(dialog.getByRole("button", { name: "Release reserve" })).toBeEnabled();
    expect(releaseRetry.upstreamStatuses).toEqual([200]);

    const afterLostRelease = await moneyEvents(pool, MONEY_RESERVE_OBLIGATION_ID);
    expect(afterLostRelease).toHaveLength(2);
    expect(afterLostRelease.find((event) => event.id === originalSetAside.id)).toMatchObject({
      event_type: "set_aside",
      amount: "20.00",
      reference: RESERVE_REFERENCE,
    });
    expect(afterLostRelease.filter((event) => event.batch_action === "refund_credit")).toEqual([
      expect.objectContaining({
        event_type: "adjustment",
        amount: "-5.00",
        reference: RELEASE_REFERENCE,
        note: "Release only the excess put-away",
      }),
    ]);

    await dialog.getByRole("button", { name: "Release reserve" }).click();
    await expect(dialog).toBeHidden();
    await expect(main.getByRole("status").filter({
      hasText: `Released $5.00 for ${MONEY_RESERVE_INDIVIDUAL_NAME}.`,
    })).toBeVisible();
    expectSameOperationKey(releaseRetry.requestBodies);
    expect(releaseRetry.upstreamStatuses).toEqual([200, 200]);
    await releaseRetry.stop();
    expect((await moneyEvents(pool, MONEY_RESERVE_OBLIGATION_ID)).map((event) => event.id).sort()).toEqual(
      afterLostRelease.map((event) => event.id).sort(),
    );

    await page.goto(settlementPath);
    await main.getByRole("tab", { name: /History/ }).click();
    const finalHistory = main.getByRole("table", { name: "Complete payment and reversal history" });
    await expect(finalHistory.getByRole("row").filter({ hasText: RESERVE_REFERENCE })).toContainText("Set aside");
    await expect(finalHistory.getByRole("row").filter({ hasText: RELEASE_REFERENCE })).toContainText("Credit refunded / released");
  });

  test("Agency Financials counts the actual class receipt and split, never the issued invoice", async ({ page }) => {
    await signIn(page);
    const response = await page.goto(`/reports/agency-financials?month=${MONEY_REPORT_MONTH}`);
    expect(response?.status()).toBe(200);
    const main = page.locator("#main");
    await expect(main.getByRole("heading", { level: 1, name: "Agency financials" })).toBeVisible();

    const income = main.getByRole("table", { name: "Income summary" });
    const transactionRow = income.getByRole("row").filter({ hasText: "Google Sheet transactions" });
    await expect(transactionRow).toContainText("$350.00");
    const classReceiptRow = income.getByRole("row").filter({ hasText: "Actual class receipts" });
    await expect(classReceiptRow).toContainText("1");
    await expect(classReceiptRow).toContainText(`$${MONEY_REPORT_GROSS}`);
    const totalIncomeRow = income.getByRole("row").filter({ hasText: "Total income" });
    await expect(totalIncomeRow).toContainText(`$${MONEY_REPORT_TOTAL_INCOME}`);
    await expect(totalIncomeRow).not.toContainText("$650.00");

    const expenses = main.getByRole("table", { name: "Expense summary" });
    const classSplitRow = expenses.getByRole("row").filter({
      hasText: "Class receipt individual share",
    });
    await expect(classSplitRow).toContainText(`$${MONEY_REPORT_INDIVIDUAL_SHARE}`);

    await main.getByRole("tab", { name: "Other income" }).click();
    const invoices = main.getByRole("table", {
      name: "Class invoice receivables and allocation reference",
    });
    const invoiceRow = invoices.getByRole("row").filter({ hasText: MONEY_REPORT_INVOICE_NUMBER });
    await expect(invoiceRow).toContainText(`$${MONEY_REPORT_GROSS}`);
    await expect(invoiceRow).toContainText("Reference only");
    await expect(invoiceRow).toContainText("Not actual cash income");

    const receipts = main.getByRole("table", { name: "Recorded receipts and other income" });
    const receiptRow = receipts.getByRole("row").filter({
      hasText: MONEY_REPORT_RECEIPT_REFERENCE,
    });
    await expect(receiptRow).toContainText("Class payment received");
    await expect(receiptRow).toContainText(`$${MONEY_REPORT_GROSS}`);
    await expect(receiptRow).toContainText(`$${MONEY_REPORT_AGENCY_SHARE}`);
    await expect(receiptRow).toContainText(`$${MONEY_REPORT_INDIVIDUAL_SHARE}`);
  });
});
