import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agencyFinancialResultIncomplete } from "@/lib/business/agency-financial-completeness";
import { getAgencyFinancialReport } from "@/lib/data/agency-financial-report";
import { agencyFinancialExportTables } from "@/lib/export/agency-financial-report";
import { createEmployee } from "@/lib/manage/employees";
import { createIndividual } from "@/lib/manage/individuals";
import { saveEmployeeDeal } from "@/lib/manage/employee-deals";
import { savePayrollCheck } from "@/lib/manage/direct-pay-operations";
import { createManualIncomeEntry, voidManualIncomeEntry, saveProgramRevenueTerm } from "@/lib/manage/agency-financials";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
function unwrap<T>(result: { ok: true; data: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

suite("Owner actuals completeness and receipt controls", () => {
  beforeAll(resetSchema, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await testPool().query(`INSERT INTO users (id,email,display_name,password_hash,role)
      VALUES ($1,'owner@example.test','Owner','x','admin')`, [ACTOR]);
  });
  afterAll(closeTestPool);

  it("keeps source income visible but marks missing verified check expenses incomplete", async () => {
    const pool = testPool();
    const employee = unwrap(await createEmployee(pool, { displayName: "Synthetic Check Employee" }, ACTOR));
    const individual = unwrap(await createIndividual(pool, { displayName: "Synthetic Individual" }, ACTOR));
    unwrap(await saveEmployeeDeal(pool, { employeeId: employee.id, directRule: "giveback_percent",
      directPercent: "0.10", agencyCutPercent: "0.20", effectiveFrom: "2026-01-01",
      reason: "Synthetic test agreement" }, ACTOR));
    const inserted = await pool.query<{ id: string }>(`INSERT INTO payroll_transactions
      (employee_id,individual_id,check_number,check_date,period_begin,payment_recipient,
       imported_amount,calculated_internal_amount,total_net_pay,transaction_fingerprint)
      VALUES ($1,$2,'CONTROL-CHECK','2026-08-15','2026-08-01','employee',1000,900,800,'owner-check-control')
      RETURNING id`, [employee.id, individual.id]);
    const transactionId = inserted.rows[0]!.id;
    const before = await getAgencyFinancialReport(pool, "2026-08");
    expect(before.totals.income.transactions).toBe("1000.0000");
    expect(before.directChecks).toHaveLength(0);
    expect(before.coverage.directTransactionsMissingVerifiedCheck).toBe(1);
    expect(agencyFinancialResultIncomplete(before.coverage)).toBe(true);
    const beforeTables = agencyFinancialExportTables(before);
    expect(beforeTables.find((table) => table.title === "Summary totals")!.rows).toContainEqual({
      section: "Result", metric: "Agency result (incomplete)", records: null, amount: "1000.0000",
    });
    expect(beforeTables.find((table) => table.title === "Transaction actuals")!.rows[0]).toMatchObject({
      sourceId: transactionId, sourcePath: `/transactions?transactionId=${transactionId}`,
      checkVerified: "No - review required",
    });
    const check = unwrap(await savePayrollCheck(pool, { employeeId: employee.id,
      checkNumber: "CONTROL-CHECK", checkDate: "2026-08-15", periodBegin: "2026-08-01",
      actualGross: "1000", actualNet: "800", verificationStatus: "verified",
      sourceTransactionIds: [transactionId] }, ACTOR));
    const after = await getAgencyFinancialReport(pool, "2026-08");
    expect(after.coverage.directTransactionsMissingVerifiedCheck).toBe(0);
    expect(agencyFinancialResultIncomplete(after.coverage)).toBe(false);
    expect(after.directChecks).toHaveLength(1);
    expect(after.totals.expenses.taxes).toBe("200.0000");
    expect(after.totals.expenses.directEmployeeKeeps).toBe("720.0000");
    expect(after.totals.agencyResult).toBe("80.0000");
    expect(after.transactions[0]).toMatchObject({ payrollCheckId: check.id, payrollCheckVerified: true });
    expect(agencyFinancialExportTables(after).find((table) => table.title === "Verified direct-pay checks")!.rows[0])
      .toMatchObject({ sourceId: check.id, sourcePath: `/masser?view=checks&month=2026-08&focusCheckId=${check.id}` });
  });

  it("rejects simultaneous duplicate receipts and preserves void history without counting income twice", async () => {
    const pool = testPool();
    const input = { serviceDate: "2026-08-12", sourceType: "other" as const,
      grossAmount: "125.25", sourceRef: "SYNTHETIC-RECEIPT-1" };
    const attempts = await Promise.all([createManualIncomeEntry(pool, input, ACTOR), createManualIncomeEntry(pool, input, ACTOR)]);
    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    expect(attempts.filter((result) => !result.ok)).toHaveLength(1);
    const receipt = unwrap(attempts.find((result) => result.ok)!);
    const active = await getAgencyFinancialReport(pool, "2026-08");
    expect(active.totals.income.manual).toBe("125.2500");
    expect(active.manualIncome).toHaveLength(1);
    unwrap(await voidManualIncomeEntry(pool, receipt.id, ACTOR, "Duplicate reference corrected in audit"));
    const voided = await getAgencyFinancialReport(pool, "2026-08");
    expect(voided.totals.income.manual).toBe("0.0000");
    expect((await pool.query<{ status: string }>("SELECT status FROM agency_manual_income_entries WHERE id=$1", [receipt.id])).rows)
      .toEqual([{ status: "void" }]);
    expect((await pool.query<{ count: string }>("SELECT count(*)::text FROM audit_logs WHERE entity_id=$1", [receipt.id])).rows[0]!.count).toBe("2");
  });

  it("flags check expenses outside the source month and counts the verified net only in the check month", async () => {
    const pool = testPool();
    const employee = unwrap(await createEmployee(pool, { displayName: "Synthetic Cross-month Employee" }, ACTOR));
    const individual = unwrap(await createIndividual(pool, { displayName: "Synthetic Cross-month Individual" }, ACTOR));
    unwrap(await saveEmployeeDeal(pool, { employeeId: employee.id, directRule: "giveback_percent",
      directPercent: "0.10", agencyCutPercent: "0.20", effectiveFrom: "2026-01-01",
      reason: "Synthetic cross-month agreement" }, ACTOR));
    const transactions = await pool.query<{ id: string }>(`INSERT INTO payroll_transactions
      (employee_id,individual_id,check_number,check_date,period_begin,payment_recipient,
       imported_amount,calculated_internal_amount,total_net_pay,transaction_fingerprint)
      VALUES ($1,$2,'CROSS-MONTH','2026-08-15','2026-08-01','employee',600,540,800,'owner-cross-month-1'),
             ($1,$2,'CROSS-MONTH','2026-08-15','2026-08-01','employee',400,360,800,'owner-cross-month-2')
      RETURNING id`, [employee.id, individual.id]);
    const check = unwrap(await savePayrollCheck(pool, { employeeId: employee.id,
      checkNumber: "CROSS-MONTH", checkDate: "2026-09-15", periodBegin: "2026-09-01",
      actualGross: "1000", actualNet: "800", verificationStatus: "verified",
      sourceTransactionIds: transactions.rows.map((row) => row.id) }, ACTOR));

    const august = await getAgencyFinancialReport(pool, "2026-08");
    expect(august.totals.income.transactions).toBe("1000.0000");
    expect(august.directChecks).toHaveLength(0);
    expect(august.totals.expenses.total).toBe("0.0000");
    expect(august.coverage.directTransactionsMissingVerifiedCheck).toBe(2);
    expect(agencyFinancialResultIncomplete(august.coverage)).toBe(true);
    for (const transaction of august.transactions) {
      expect(transaction).toMatchObject({ payrollCheckId: check.id, payrollCheckVerified: true,
        payrollCheckServiceDate: "2026-09-01", payrollCheckExpenseIncluded: false });
    }
    const tables = agencyFinancialExportTables(august);
    expect(tables.find((table) => table.title === "Summary totals")!.rows).toContainEqual({
      section: "Result", metric: "Agency result (incomplete)", records: null, amount: "1000.0000",
    });
    for (const row of tables.find((table) => table.title === "Transaction actuals")!.rows) {
      expect(row).toMatchObject({ checkVerified: "Yes", checkExpenseIncluded: "No - review required",
        checkServiceDate: "2026-09-01", checkSourcePath: `/masser?view=checks&month=2026-09&focusCheckId=${check.id}` });
    }
    const september = await getAgencyFinancialReport(pool, "2026-09");
    expect(september.totals.income.transactions).toBe("0.0000");
    expect(september.directChecks).toHaveLength(1);
    expect(september.directChecks[0]).toMatchObject({ id: check.id, netAmount: "800.0000", employeeOwesAgency: "80.0000" });
    expect(september.totals.expenses.taxes).toBe("200.0000");
    expect(september.totals.expenses.directEmployeeKeeps).toBe("720.0000");
    expect(september.totals.expenses.total).toBe("920.0000");
    expect(september.coverage.directTransactionsMissingVerifiedCheck).toBe(0);
    expect(await getAgencyFinancialReport(pool, "2026-08")).toEqual(august);
  });

  it("does not treat another employee's legacy check link as verified expense provenance", async () => {
    const pool = testPool();
    const employee = unwrap(await createEmployee(pool, { displayName: "Synthetic Source Employee" }, ACTOR));
    const otherEmployee = unwrap(await createEmployee(pool, { displayName: "Synthetic Other Employee" }, ACTOR));
    const check = unwrap(await savePayrollCheck(pool, { employeeId: otherEmployee.id,
      checkNumber: "OTHER-EMPLOYEE", checkDate: "2026-08-15", periodBegin: "2026-08-01",
      actualGross: "1000", actualNet: "800", verificationStatus: "verified" }, ACTOR));
    await pool.query(`INSERT INTO payroll_transactions
      (employee_id,payroll_check_id,period_begin,payment_recipient,imported_amount,
       calculated_internal_amount,transaction_fingerprint)
      VALUES ($1,$2,'2026-08-01','employee',1000,900,'owner-foreign-check')`, [employee.id, check.id]);
    const report = await getAgencyFinancialReport(pool, "2026-08");
    expect(report.coverage.directTransactionsMissingVerifiedCheck).toBe(1);
    expect(report.directChecks).toHaveLength(0);
    expect(report.transactions[0]).toMatchObject({ payrollCheckVerified: false, payrollCheckServiceDate: null,
      payrollCheckExpenseIncluded: false });
    expect(agencyFinancialResultIncomplete(report.coverage)).toBe(true);
  });

  it("requires a dated replacement for an expired program split instead of silently keeping all reimbursement income", async () => {
    const pool = testPool();
    const individual = unwrap(await createIndividual(pool, { displayName: "Synthetic Split Individual" }, ACTOR));
    const programId = (await pool.query<{ id: string }>("SELECT id FROM programs WHERE code='COM_HAB'")).rows[0]!.id;
    unwrap(await saveProgramRevenueTerm(pool, { individualId: individual.id, programId,
      agencySharePercent: "60", effectiveFrom: "2026-07-01", effectiveTo: "2026-07-31",
      reason: "Synthetic dated agreement" }, ACTOR));
    const input = { individualId: individual.id, programId, serviceDate: "2026-08-12",
      sourceType: "reimbursement" as const, grossAmount: "100", sourceRef: "EXPIRED-SPLIT" };
    const blocked = await createManualIncomeEntry(pool, input, ACTOR);
    expect(blocked).toMatchObject({ ok: false, code: "conflict" });
    expect((await getAgencyFinancialReport(pool, "2026-08")).manualIncome).toHaveLength(0);
    unwrap(await saveProgramRevenueTerm(pool, { individualId: individual.id, programId,
      agencySharePercent: "0", effectiveFrom: "2026-08-01", reason: "Synthetic explicit zero agency share" }, ACTOR));
    const receipt = unwrap(await createManualIncomeEntry(pool, input, ACTOR));
    expect(receipt.agencyAmount).toBe("0.0000");
    expect(receipt.individualAmount).toBe("100.0000");
    const report = await getAgencyFinancialReport(pool, "2026-08");
    expect(report.totals.income.manual).toBe("100.0000");
    expect(report.totals.expenses.manualIndividualShare).toBe("100.0000");
    expect(report.totals.agencyResult).toBe("0.0000");
  });
});
