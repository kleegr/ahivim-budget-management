import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { commitStagedImport } from "../../src/lib/import/commit";
import { stageRows } from "../../src/lib/import/stage";
import { DEFAULT_SYNC_CONFIG, SHEET_SYNC_CONFIG_KEY } from "../../src/lib/sheets/config";
import { sheetSourceIdentity } from "../../src/lib/sheets/identity";
import { parseSheetCsv } from "../../src/lib/sheets/parse-csv";
import {
  ADMIN_EMAIL, ADMIN_PASSWORD, EXPECTED_DISPOSABLE_DB_HOST, RESET_CONFIRMATION,
  TEST_DB_URL, assertSafeE2eDatabaseReset,
} from "./fixtures";

const ROUTE = "/api/sync/source-base-recovery";
const REVIEW = "/exceptions?kind=rate";
const DERIVED_FIELDS = ["calculated_internal_amount", "employee_payment_amount", "agency_additional_amount", "internal_amount_mismatch"];
const CASH_AND_SOURCE_TABLES = ["import_rows", "import_warnings", "imported_files", "import_batches",
  "sheet_sync_rows", "sheet_sync_runs", "sheet_sync_conflicts", "rate_exceptions", "employee_payroll_checks",
  "settlement_obligations", "settlement_obligation_transactions", "settlement_events", "service_allocations",
  "service_sessions", "budget_authorizations", "budget_periods", "program_rate_schedules"] as const;
type Transaction = { id: string; import_row_id: string; source_file_id: string; source_row_number: number;
  employee_id: string; individual_id: string; check_number: string };
type SavedResult = { batchAuditId: string; acceptanceAuditId: string; transactionCount: number;
  alreadyApplied: boolean; status: "accepted" | "undone" };
type AttemptBody = { action: "accept" | "undo"; reason: string; operationKey: string; sourceHash: string;
  transactionIds?: string[]; acceptanceAuditId?: string };

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(url => url.pathname === "/dashboard");
}

test.describe.serial("Historical Employee base correction with real source and audited reversal", () => {
  let pool: Pool;
  let sourceHash: string;
  let fileId: string;
  let batchId: string;
  let runId: string;
  let actorId: string;
  let transactions: Transaction[] = [];
  let previousConfig: { value: unknown; updated_by_user_id: string | null; updated_at: string } | undefined;

  test.beforeAll(async () => {
    assertSafeE2eDatabaseReset({ connectionString: TEST_DB_URL,
      expectedHost: EXPECTED_DISPOSABLE_DB_HOST, confirmation: RESET_CONFIRMATION });
    // Import attribution uses a second connection after its source commit.
    pool = new Pool({ connectionString: TEST_DB_URL, max: 2 });
    const csv = await readFile(path.resolve("tests/e2e/source-base.csv"), "utf8");
    const parsed = parseSheetCsv(csv);
    expect(parsed.ahivimRows.map(row => row.sourceRowNumber)).toEqual([3, 4, 5]);
    sourceHash = parsed.snapshotSha256;
    actorId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [ADMIN_EMAIL])).rows[0]!.id;
    previousConfig = (await pool.query("SELECT value,updated_by_user_id,updated_at::text FROM app_settings WHERE key=$1",
      [SHEET_SYNC_CONFIG_KEY])).rows[0];
    await pool.query(`INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [SHEET_SYNC_CONFIG_KEY, JSON.stringify(DEFAULT_SYNC_CONFIG)]);

    // These are explicit synthetic stored-rate pairs. The real commit retains
    // original raw source cells, fingerprints, allocations and source links.
    const ratesByProgram = { COM_HAB: { internalRate: "21", agencyRate: "25" },
      DAY_HAB: { internalRate: "17", agencyRate: "19" } };
    const staging = stageRows(parsed.ahivimRows, { ratesByProgram, individuals: [], individualAliases: [],
      employees: [], employeeAliases: [], knownFingerprints: new Set(), knownNaturalKeys: new Set() });
    expect(staging.counts.valid).toBe(3);
    const committed = await commitStagedImport(pool, { checksumSha256: createHash("sha256").update(csv).digest("hex"),
      originalFilename: "synthetic-source-base.csv", byteSize: Buffer.byteLength(csv), templateDetected: "ahivim",
      sheetSummary: { synthetic: true }, parsedRows: parsed.ahivimRows, staging, ratesByProgram,
      committedByUserId: actorId });
    expect(committed.counts.transactions).toBe(3);
    fileId = committed.importedFileId;
    batchId = committed.importBatchId;
    transactions = (await pool.query<Transaction>(`SELECT id,import_row_id,source_file_id,source_row_number,
      employee_id,individual_id,check_number FROM payroll_transactions WHERE import_batch_id=$1 ORDER BY source_row_number`, [batchId])).rows;
    expect(transactions).toHaveLength(3);

    // Reproduce only the four documented old-engine projections, scoped to
    // this imported fixture. No pre-existing source row or payroll is edited.
    await pool.query(`UPDATE payroll_transactions SET calculated_internal_amount=imported_amount,
      employee_payment_amount=imported_amount,agency_additional_amount=0,internal_amount_mismatch=true
      WHERE import_batch_id=$1`, [batchId]);
    await pool.query(`INSERT INTO import_warnings(import_batch_id,import_row_id,category,severity,message,details)
      SELECT import_batch_id,import_row_id,'internal_amount_mismatch','warning','Synthetic original calculation disagreement',
        jsonb_build_object('application',imported_amount::text,'spreadsheet',spreadsheet_internal_amount::text,
          'difference',(imported_amount-spreadsheet_internal_amount)::text)
      FROM payroll_transactions WHERE import_batch_id=$1`, [batchId]);
    await pool.query(`UPDATE payroll_transactions SET is_paid=true,paid_at=now()
      WHERE id=$1`, [transactions[2]!.id]);
    // A synthetic successful source snapshot belongs only to these three rows.
    // Using the commit directly avoids a fixture sync reviewing unrelated seed rows.
    runId = (await pool.query<{ id: string }>(`INSERT INTO sheet_sync_runs(trigger,status,snapshot_sha256,
      source_rows,rows_added,import_batch_id,triggered_by_user_id,finished_at)
      VALUES('manual','success',$1,3,3,$2,$3,now()) RETURNING id`, [sourceHash,batchId,actorId])).rows[0]!.id;
    for (const transaction of transactions) {
      const row = staging.rows.find(item => item.sourceRowNumber === transaction.source_row_number)!;
      const original = parsed.ahivimRows.find(item => item.sourceRowNumber === transaction.source_row_number)!;
      await pool.query(`INSERT INTO sheet_sync_rows(natural_key,fingerprint,source_row_number,payroll_transaction_id,
        identity,state,first_seen_run_id,last_seen_run_id) VALUES($1,$2,$3,$4,$5::jsonb,'active',$6,$6)`,
      [row.naturalKey,row.fingerprint,row.sourceRowNumber,transaction.id,JSON.stringify(sheetSourceIdentity(original)),runId]);
    }
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      // Remove only this disposable fixture; append-only API audits remain.
      if (batchId) {
        await pool.query("DELETE FROM sheet_sync_rows WHERE payroll_transaction_id=ANY($1::uuid[])", [transactions.map(row => row.id)]);
        await pool.query("DELETE FROM sheet_sync_runs WHERE id=$1", [runId]);
        await pool.query("DELETE FROM rate_exceptions WHERE import_batch_id=$1", [batchId]);
        await pool.query("DELETE FROM service_allocations WHERE payroll_transaction_id=ANY($1::uuid[])", [transactions.map(row => row.id)]);
        await pool.query("DELETE FROM payroll_transactions WHERE import_batch_id=$1", [batchId]);
        await pool.query("DELETE FROM service_sessions WHERE import_batch_id=$1", [batchId]);
        await pool.query("DELETE FROM imported_files WHERE id=$1", [fileId]);
        if (transactions[0]) {
          await pool.query("DELETE FROM employee_payroll_checks WHERE employee_id=$1", [transactions[0].employee_id]);
          await pool.query("DELETE FROM employees WHERE id=$1", [transactions[0].employee_id]);
          await pool.query("DELETE FROM individuals WHERE id=$1", [transactions[0].individual_id]);
        }
      }
      if (previousConfig) await pool.query(`UPDATE app_settings SET value=$2::jsonb,updated_by_user_id=$3,
        updated_at=$4::timestamptz WHERE key=$1`, [SHEET_SYNC_CONFIG_KEY,JSON.stringify(previousConfig.value),
        previousConfig.updated_by_user_id,previousConfig.updated_at]);
      else await pool.query("DELETE FROM app_settings WHERE key=$1", [SHEET_SYNC_CONFIG_KEY]);
    } finally { await pool.end(); }
  });

  async function controls() {
    const result: Record<string, unknown> = {};
    for (const table of CASH_AND_SOURCE_TABLES) result[table] = (await pool.query(
      `SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS hash FROM ${table} t`)).rows[0]!.hash;
    result.otherPayroll = (await pool.query(`SELECT md5(COALESCE(string_agg(
      (to_jsonb(t)-$1::text[])::text,'' ORDER BY id),'')) AS hash FROM payroll_transactions t`, [DERIVED_FIELDS])).rows[0]!.hash;
    result.paid = (await pool.query("SELECT to_jsonb(t)::text AS row FROM payroll_transactions t WHERE id=$1", [transactions[2]!.id])).rows[0]!.row;
    return result;
  }

  async function mutableFacts() {
    return (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payroll_transactions t) AS payroll,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM audit_logs t) AS audits,
      (SELECT jsonb_agg(to_jsonb(t)) FROM settlement_ledger_state t) AS ledger`)).rows[0]!;
  }

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    test(`owner saves, safely retries and reverses an exact batch at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const runtimeErrors: string[] = [];
      page.on("pageerror", error => runtimeErrors.push(error.message));
      const immutable = await controls(), original = await mutableFacts();
      await signIn(page);
      await page.goto(REVIEW);
      const panel = page.getByRole("region", { name: "Employee base corrections", exact: true });
      await expect(panel).toContainText("2 eligible · 1 need further review");
      const table = panel.getByRole("table", { name: "Historical Employee base corrections" });
      const sourceRow = (number: number) => table.getByRole("row").filter({ has: page.getByRole("checkbox",
        { name: `Select correction for Source Base Individual, source row ${number}`, exact: true }) });
      await expect(sourceRow(5).getByRole("checkbox")).toBeDisabled();
      await expect(sourceRow(5)).toContainText("Paid");
      for (const [number, base, additional] of [[3,"$84.00","$16.00"],[4,"exact 80.5263","exact 9.4737"]] as const) {
        await sourceRow(number).getByText("Related amounts", { exact: true }).click();
        await expect(sourceRow(number)).toContainText(base);
        await expect(sourceRow(number)).toContainText(additional);
        await expect(sourceRow(number)).toContainText("Employee payment allocation:");
        await expect(sourceRow(number)).toContainText("Amount mismatch: Flagged → Clear");
      }
      await expect(sourceRow(4)).toContainText("Group-hour history uses Employee base.");
      const first = transactions[0]!;
      await expect(sourceRow(3).getByRole("link", { name: "Transaction", exact: true }))
        .toHaveAttribute("href", `/transactions?transactionId=${first.id}`);
      const sourceHref = `/imports/${fileId}/corrections?row=${first.import_row_id}#row-${first.import_row_id}`;
      await expect(sourceRow(3).getByRole("link", { name: "Source row 3", exact: true })).toHaveAttribute("href", sourceHref);
      await sourceRow(3).getByRole("link", { name: "Source row 3", exact: true }).click();
      await expect(page).toHaveURL(new URL(sourceHref, page.url()).href);
      const lockedSource = page.locator(`#row-${first.import_row_id}`);
      await expect(lockedSource).toContainText("Applied to the ledger");
      await expect(lockedSource.getByRole("button", { name: "Apply corrected row", exact: true })).toHaveCount(0);
      await page.goto(REVIEW);
      await panel.getByLabel("Select all 2 eligible corrections", { exact: true }).check();
      await expect(sourceRow(5).getByRole("checkbox")).not.toBeChecked();
      await panel.getByRole("button", { name: "Review 2 selected corrections", exact: true }).click();
      const form = panel.getByRole("form", { name: "Review Employee base correction" });
      await expect(form).toContainText("Save 2 corrections");
      await expect(form).toContainText("$190.00 → $164.53 (exact 164.5263)");
      await expect(form).toContainText("$0.00 → $25.47 (exact 25.4737)");
      await expect(form).toContainText("affected historical usage and remaining hours");
      await expect(form.getByRole("button", { name: "Save corrections", exact: true })).toBeDisabled();
      const reason = `Synthetic ${viewport.width}px original source and stored-rate correction`;
      await form.getByLabel("Reason for this correction", { exact: true }).fill(reason);
      await page.screenshot({ path: test.info().outputPath("source-base-exact-preview.png"), fullPage: true });

      const attempts: Array<{ input: AttemptBody; data: SavedResult }> = [];
      // Each request reaches the actual authenticated route. Only its first
      // successful response is lost, proving the UI retains its retry key.
      await page.route(`**${ROUTE}`, async route => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.ok).toBe(true);
        const input = route.request().postDataJSON() as AttemptBody;
        const firstResponse = !attempts.some(attempt => attempt.input.action === input.action);
        attempts.push({ input, data: body.data });
        if (firstResponse) await route.abort("failed");
        else await route.fulfill({ response });
      });

      await form.getByRole("button", { name: "Save corrections", exact: true }).click();
      await expect(panel.getByRole("alert")).toContainText("Could not confirm the result");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.data).toMatchObject({ status: "accepted", transactionCount: 2, alreadyApplied: false });
      expect(attempts[0]!.input.sourceHash).toBe(sourceHash);
      expect(attempts[0]!.input.transactionIds!.sort()).toEqual(transactions.slice(0,2).map(row => row.id).sort());
      const acceptanceId = attempts[0]!.data.acceptanceAuditId;
      const saved = await mutableFacts();
      expect(await controls()).toEqual(immutable);
      expect((await pool.query(`SELECT calculated_internal_amount,employee_payment_amount,agency_additional_amount,
        internal_amount_mismatch FROM payroll_transactions WHERE id=ANY($1::uuid[]) ORDER BY source_row_number`,
      [transactions.slice(0,2).map(row => row.id)])).rows).toEqual([
        { calculated_internal_amount:"84.0000",employee_payment_amount:"84.0000",agency_additional_amount:"16.0000",internal_amount_mismatch:false },
        { calculated_internal_amount:"80.5263",employee_payment_amount:"80.5263",agency_additional_amount:"9.4737",internal_amount_mismatch:false },
      ]);
      await expect(form.getByLabel("Reason for this correction", { exact: true })).toHaveValue(reason);
      await form.getByRole("button", { name: "Save corrections", exact: true }).click();
      await expect(page).toHaveURL(new URL(`${REVIEW}&sourceBaseReview=${attempts[0]!.data.batchAuditId}#source-base-history-${acceptanceId}`,page.url()).href);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]!.input).toEqual(attempts[0]!.input);
      expect(attempts[1]!.data).toEqual({ ...attempts[0]!.data, alreadyApplied: true });
      expect(await mutableFacts()).toEqual(saved);
      const history = page.locator(`#source-base-history-${acceptanceId}`);
      await expect(history).toContainText("2 corrections · Saved");
      await expect(history).toContainText(reason);
      await history.getByText("Corrected records (2)", { exact: true }).click();
      await expect(history.getByRole("link", { name: "Original source row 3", exact: true })).toHaveAttribute("href", sourceHref);
      await expect(history.getByRole("link", { name: "Original source row 4", exact: true }))
        .toHaveAttribute("href", `/imports/${fileId}/corrections?row=${transactions[1]!.import_row_id}#row-${transactions[1]!.import_row_id}`);
      await expect(history.getByRole("link", { name: "Original source row 5", exact: true })).toHaveCount(0);
      expect(await history.getByRole("link", { name: "Transaction", exact: true }).evaluateAll(links => links.map(link => link.getAttribute("href")).sort()))
        .toEqual(transactions.slice(0,2).map(row => `/transactions?transactionId=${row.id}`).sort());
      await expect(history.getByRole("button", { name: "Review reversal", exact: true })).toBeEnabled();
      await history.getByRole("button", { name: "Review reversal", exact: true }).click();
      await expect(form).toContainText("Reverse 2 corrections");
      await expect(form).toContainText("$164.53 (exact 164.5263) → $190.00");
      await expect(form.getByRole("button", { name: "Record reversal", exact: true })).toBeDisabled();
      const undoReason = `Synthetic ${viewport.width}px reversal preserves original financial history`;
      await form.getByLabel("Reason for this reversal", { exact: true }).fill(undoReason);
      await form.getByRole("button", { name: "Record reversal", exact: true }).click();
      await expect(panel.getByRole("alert")).toContainText("Could not confirm the result");
      expect(attempts).toHaveLength(3);
      expect(attempts[2]!.input.acceptanceAuditId).toBe(acceptanceId);
      expect(attempts[2]!.data).toMatchObject({ status: "undone", transactionCount: 2, alreadyApplied: false, acceptanceAuditId: acceptanceId });
      expect(attempts[2]!.data.batchAuditId).not.toBe(acceptanceId);
      const undone = await mutableFacts();
      expect(undone.payroll).toEqual(original.payroll);
      const priorAuditIds = new Set(original.audits.map((row: { id: string }) => row.id));
      expect(undone.audits.filter((row: { id: string }) => priorAuditIds.has(row.id))).toEqual(original.audits);
      expect(await controls()).toEqual(immutable);
      await form.getByRole("button", { name: "Record reversal", exact: true }).click();
      await expect(page).toHaveURL(new URL(`${REVIEW}&sourceBaseReview=${attempts[2]!.data.batchAuditId}#source-base-history-${acceptanceId}`,page.url()).href);
      await expect(history).toContainText("2 corrections · Reversed");
      expect(attempts).toHaveLength(4);
      expect(attempts[3]!.input).toEqual(attempts[2]!.input);
      expect(attempts[3]!.data).toEqual({ ...attempts[2]!.data, alreadyApplied: true });
      expect(await mutableFacts()).toEqual(undone);
      await expect(history.getByRole("button", { name: "Review reversal", exact: true })).toHaveCount(0);
      const auditRows = (await pool.query(`SELECT id,user_id,action,reason,metadata FROM audit_logs
        WHERE metadata->>'operationKey'=ANY($1::text[]) ORDER BY action,id`,
      [[attempts[0]!.input.operationKey,attempts[2]!.input.operationKey]])).rows;
      expect(auditRows).toHaveLength(6);
      expect(auditRows.every(row => row.user_id === actorId && row.metadata.sourceHash === sourceHash)).toBe(true);
      expect(auditRows.every(row => row.reason === (row.action.endsWith("reversed") ? undoReason : reason))).toBe(true);
      expect(auditRows.filter(row => row.action === "source_base_recovery_accepted")).toHaveLength(2);
      const reversals = auditRows.filter(row => row.action === "source_base_recovery_reversed");
      expect(reversals).toHaveLength(2);
      expect(reversals.every(row => auditRows.some(accepted => accepted.id === row.metadata.acceptanceAuditId
        && accepted.action === "source_base_recovery_accepted"))).toBe(true);
      await page.screenshot({ path: test.info().outputPath("source-base-reversed-history.png"), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(runtimeErrors).toEqual([]);
    });
  }
});
