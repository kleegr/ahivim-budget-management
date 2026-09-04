import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileChecksum } from "@/lib/business/fingerprint";
import { parseWorkbook } from "@/lib/excel/parse-workbook";
import { commit, uploadAndStage } from "@/lib/import/service";
import { reconcileTransactionWorkbook } from "@/lib/import/transaction-workbook";
import {
  closeTestPool,
  countRows,
  hasTestDatabase,
  resetSchema,
  testPool,
} from "../support/database";
import {
  AGENCY_PAYEE,
  buildWorkbook,
  SINGLE_ROWS,
  type FixtureRow,
} from "../support/workbook";

const suite = hasTestDatabase ? describe : describe.skip;

suite("transaction workbook recovery (real PostgreSQL)", () => {
  beforeAll(resetSchema, 60_000);
  afterAll(closeTestPool);

  it("inserts one safe missing row once while exact and operational rows remain no-ops/review", async () => {
    const exact = { ...SINGLE_ROWS[0]! };
    const seedBytes = await buildWorkbook([exact]);
    const seed = await uploadAndStage(testPool(), {
      filename: "recovery-seed.xlsx",
      bytes: seedBytes,
      uploadedByUserId: null,
    });
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;
    const seeded = await commit(testPool(), seed.fileId, null);
    expect(seeded.ok).toBe(true);
    expect(await countRows("payroll_transactions")).toBe(1);

    const safeMissing: FixtureRow = {
      ...exact,
      checkDate: "2025-01-24",
      checkNumber: "RECOVERY-NEW",
      hours: 6,
      amount: 150,
      totalNetPay: 150,
      periodBegin: "2025-01-16",
      periodEnd: "2025-01-31",
      internalAmount: 126,
    };
    const operational: FixtureRow = {
      ...exact,
      payTo: AGENCY_PAYEE,
      checkDate: "2025-02-07",
      checkNumber: "RECOVERY-DENIED",
      hours: -31.25,
      amount: -625,
      totalNetPay: -625,
      periodBegin: "2025-01-16",
      periodEnd: "2025-01-31",
      employee: "Denied Billing",
      internalAmount: -525,
    };
    const recoveryBytes = await buildWorkbook([exact, safeMissing, operational]);
    const parsed = await parseWorkbook(recoveryBytes);
    const source = {
      fileName: "transaction-recovery.xlsx",
      byteSize: recoveryBytes.byteLength,
      checksumSha256: fileChecksum(recoveryBytes),
    };

    const dryRun = await reconcileTransactionWorkbook(testPool(), parsed, source);
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.summary).toMatchObject({
      exact: 1,
      missingNew: 1,
      ambiguousReview: 1,
      applicable: 1,
    });
    expect(dryRun.exceptions.find((row) => row.sourceRowNumber === 5)).toMatchObject({
      classification: "ambiguous_review",
      canApply: false,
      identity: { employee: "Denied Billing", amount: "-625" },
    });
    expect(await countRows("payroll_transactions")).toBe(1);

    const first = await reconcileTransactionWorkbook(testPool(), parsed, source, { apply: true });
    expect(first.mode).toBe("apply");
    expect(first.preApplySummary).toMatchObject({ exact: 1, missingNew: 1, applicable: 1 });
    expect(first.applySummary).toMatchObject({
      alreadyCommitted: false,
      sourceRowsPreserved: 3,
      transactionsInserted: 1,
      accountedAgencyGross: "400.0000",
      accountedInternalAmount: "336.0000",
      reviewRowsPreserved: 1,
      duplicateRowsPreserved: 1,
    });
    expect(first.summary).toMatchObject({ exact: 2, ambiguousReview: 1, applicable: 0 });
    expect(await countRows("payroll_transactions")).toBe(2);

    const { rows: reviewRows } = await testPool().query<{
      status: string;
      employee_raw: string | null;
    }>(
      `SELECT r.status, r.raw_values->'raw'->>'employee' AS employee_raw
         FROM import_rows r
        WHERE r.import_batch_id = $1 AND r.source_row_number = 5`,
      [first.applySummary!.importBatchId],
    );
    expect(reviewRows).toEqual([{ status: "needs_review", employee_raw: "Denied Billing" }]);
    const { rows: operationalEmployees } = await testPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM employees WHERE normalized_name = 'billing denied'`,
    );
    expect(operationalEmployees[0]!.count).toBe("0");
    const { rows: reconciliation } = await testPool().query<{
      source_agency_gross: string;
      imported_agency_gross: string;
      source_internal_amount: string;
      imported_internal_amount: string;
    }>(
      `SELECT source_agency_gross::text, imported_agency_gross::text,
              source_internal_amount::text, imported_internal_amount::text
         FROM import_batches
        WHERE id = $1`,
      [first.applySummary!.importBatchId],
    );
    expect(reconciliation[0]).toEqual({
      source_agency_gross: "-225.0000",
      imported_agency_gross: "400.0000",
      source_internal_amount: "-189.0000",
      imported_internal_amount: "336.0000",
    });

    const second = await reconcileTransactionWorkbook(testPool(), parsed, source, { apply: true });
    expect(second.applySummary).toMatchObject({
      alreadyCommitted: true,
      transactionsInserted: 0,
      accountedAgencyGross: "400.0000",
      accountedInternalAmount: "336.0000",
    });
    expect(second.applySummary!.importBatchId).toBe(first.applySummary!.importBatchId);
    expect(await countRows("payroll_transactions")).toBe(2);
    expect(await countRows("import_batches")).toBe(2); // seed + one recovery batch
  }, 120_000);
});
