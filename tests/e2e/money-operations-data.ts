import type { PgLikePool } from "../../src/lib/import/commit";
import {
  createClassInvoiceDraft,
  issueClassInvoice,
} from "../../src/lib/manage/class-invoices";
import {
  createManualIncomeEntry,
  saveProgramRevenueTerm,
} from "../../src/lib/manage/agency-financials";
import {
  E2E_CLASS_ISSUED_INVOICE,
  LINKED_INDIVIDUAL_ID,
} from "./fixtures";
import {
  MONEY_REPORT_AGENCY_SHARE,
  MONEY_REPORT_GROSS,
  MONEY_REPORT_INDIVIDUAL_SHARE,
  MONEY_REPORT_INVOICE_NUMBER,
  MONEY_REPORT_RECEIPT_REFERENCE,
  MONEY_RESERVE_INDIVIDUAL_ID,
  MONEY_RESERVE_INDIVIDUAL_NAME,
  MONEY_RESERVE_OBLIGATION_ID,
  MONEY_RESERVE_ORIGINAL_AMOUNT,
  MONEY_WORKFLOW_CHECK_NUMBER,
  MONEY_WORKFLOW_DATE,
  MONEY_WORKFLOW_EMPLOYEE_ID,
  MONEY_WORKFLOW_EMPLOYEE_NAME,
  MONEY_WORKFLOW_OBLIGATION_ID,
  MONEY_WORKFLOW_ORIGINAL_AMOUNT,
} from "./money-operations-fixtures";

function unwrap<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
}

/**
 * Adds isolated facts for the append-only payment workflows and one same-month
 * issued-invoice/actual-receipt pair. The invoice remains a receivable reference;
 * only the receipt enters Agency Financials income.
 */
export async function seedMoneyOperationsAcceptanceData(
  pool: PgLikePool,
  actorId: string,
): Promise<{
  obligationId: string;
  reserveObligationId: string;
  classInvoiceId: string;
  classReceiptId: string;
}> {
  await pool.query(
    `INSERT INTO employees (id, normalized_name, display_name, external_ref, notes)
     VALUES ($1, 'e2e-money-workflow-employee', $2, 'E2E-MONEY-WORKER-001',
             'Disposable append-only Money operations browser acceptance')`,
    [MONEY_WORKFLOW_EMPLOYEE_ID, MONEY_WORKFLOW_EMPLOYEE_NAME],
  );
  await pool.query(
    `INSERT INTO individuals
       (id, normalized_name, display_name, external_ref, category, notes)
     VALUES ($1, 'e2e-individual-put-away', $2, 'E2E-MONEY-PERSON-001',
             'Put-away acceptance',
             'Disposable append-only individual reserve release acceptance')`,
    [MONEY_RESERVE_INDIVIDUAL_ID, MONEY_RESERVE_INDIVIDUAL_NAME],
  );
  await pool.query(
    `INSERT INTO settlement_obligations
       (id, source_key, kind, direction, individual_id, original_amount,
        period_begin, period_end, calculation_metadata, created_by_user_id)
     VALUES ($1, 'e2e:money-workflow:individual-reserve', 'individual_masser',
             'reserve', $2, $3, '2026-09-01', '2026-09-30',
             $4::jsonb, $5)`,
    [
      MONEY_RESERVE_OBLIGATION_ID,
      MONEY_RESERVE_INDIVIDUAL_ID,
      MONEY_RESERVE_ORIGINAL_AMOUNT,
      JSON.stringify({
        flow: "e2e_money_acceptance",
        source: "disposable_e2e_seed",
        account: "E2E Put-away",
      }),
      actorId,
    ],
  );
  await pool.query(
    `INSERT INTO settlement_obligations
       (id, source_key, kind, direction, employee_id, original_amount,
        check_number, check_date, period_begin, period_end,
        calculation_metadata, created_by_user_id)
     VALUES ($1, 'e2e:money-workflow:employee-giveback', 'employee_giveback',
             'receivable', $2, $3, $4, $5::date, '2026-09-01', '2026-09-04',
             $6::jsonb, $7)`,
    [
      MONEY_WORKFLOW_OBLIGATION_ID,
      MONEY_WORKFLOW_EMPLOYEE_ID,
      MONEY_WORKFLOW_ORIGINAL_AMOUNT,
      MONEY_WORKFLOW_CHECK_NUMBER,
      MONEY_WORKFLOW_DATE,
      JSON.stringify({
        flow: "e2e_money_acceptance",
        source: "disposable_e2e_seed",
      }),
      actorId,
    ],
  );

  const source = await pool.query<{
    class_budget_period_id: string;
    program_id: string;
    class_activity_id: string;
  }>(
    `SELECT invoice.class_budget_period_id, budget.program_id,
            line.class_activity_id
       FROM class_invoices invoice
       JOIN class_budget_periods budget
         ON budget.id = invoice.class_budget_period_id
       JOIN class_invoice_lines line
         ON line.class_invoice_id = invoice.id
      WHERE invoice.invoice_number = $1
        AND budget.program_id IS NOT NULL
        AND line.class_activity_id IS NOT NULL
      ORDER BY line.sort_order, line.id
      LIMIT 1`,
    [E2E_CLASS_ISSUED_INVOICE],
  );
  const classSource = source.rows[0];
  if (!classSource) throw new Error("The class/document seed did not create its canonical class links.");

  unwrap(await saveProgramRevenueTerm(pool, {
    individualId: LINKED_INDIVIDUAL_ID,
    programId: classSource.program_id,
    agencySharePercent: "75",
    effectiveFrom: "2026-01-01",
    notes: "Disposable Agency Financials browser acceptance split",
    reason: "Verify the actual class receipt split in browser acceptance.",
  }, actorId));

  const draft = unwrap(await createClassInvoiceDraft(pool, {
    classBudgetPeriodId: classSource.class_budget_period_id,
    invoiceNumber: MONEY_REPORT_INVOICE_NUMBER,
    invoiceDate: MONEY_WORKFLOW_DATE,
    servicePeriodStart: "2026-09-01",
    servicePeriodEnd: MONEY_WORKFLOW_DATE,
    billToName: "Linked Individual",
    purpose: "COMMUNITY CLASSES",
    notes: "Receivable reference for Agency Financials browser acceptance",
    lines: [{
      activityId: classSource.class_activity_id,
      serviceDate: MONEY_WORKFLOW_DATE,
      quantity: "1",
      unitPrice: MONEY_REPORT_GROSS,
      discountAmount: "0",
    }],
  }, actorId));
  const issued = unwrap(await issueClassInvoice(pool, draft.id, actorId, {
    reason: "Verify issued invoices remain receivable-only in Agency Financials.",
  }));
  if (issued.totalAmount !== MONEY_REPORT_GROSS) {
    throw new Error(`Unexpected class invoice total ${issued.totalAmount}.`);
  }

  const receipt = unwrap(await createManualIncomeEntry(pool, {
    serviceDate: MONEY_WORKFLOW_DATE,
    sourceType: "class",
    individualId: LINKED_INDIVIDUAL_ID,
    programId: classSource.program_id,
    grossAmount: MONEY_REPORT_GROSS,
    sourceRef: MONEY_REPORT_RECEIPT_REFERENCE,
    notes: "Disposable actual class receipt for Agency Financials acceptance",
  }, actorId));
  if (
    receipt.grossAmount !== MONEY_REPORT_GROSS
    || receipt.agencyAmount !== MONEY_REPORT_AGENCY_SHARE
    || receipt.individualAmount !== MONEY_REPORT_INDIVIDUAL_SHARE
  ) {
    throw new Error(
      `Unexpected class receipt split ${receipt.grossAmount}/${receipt.agencyAmount}/${receipt.individualAmount}.`,
    );
  }

  return {
    obligationId: MONEY_WORKFLOW_OBLIGATION_ID,
    reserveObligationId: MONEY_RESERVE_OBLIGATION_ID,
    classInvoiceId: issued.id,
    classReceiptId: receipt.id,
  };
}
