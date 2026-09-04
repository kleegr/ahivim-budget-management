import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { groupSourcePayments } from "@/components/transactions/source-payment-grouping";
import { computeGridTotals, sourcePaymentIdentity } from "@/lib/business/transaction-totals";
import { filterTransactionsBySourcePaymentIdentity } from "@/lib/transactions/initial-filters";
import type { GridTransaction } from "@/lib/data/transactions-grid";

function transaction(overrides: Partial<GridTransaction> = {}): GridTransaction {
  return {
    id: "row-1",
    serviceDate: "2026-08-01",
    payTo: "Excellent Staffing",
    checkDate: "2026-08-21",
    checkNumber: "CHK-900",
    hours: "10.00",
    rate: "25.00",
    employeeRate: "21.00",
    gross: "250.00",
    totalNetPay: "46858.71",
    verifiedCheckGross: null,
    verifiedCheckNet: null,
    withholding: null,
    verificationStatus: null,
    periodBegin: "2026-08-01",
    periodEnd: "2026-08-15",
    program: "Community Habilitation",
    programCode: "COMHAB",
    programId: "program-1",
    individual: "Test Individual",
    individualId: "individual-1",
    employee: "First Employee",
    employeeId: "employee-1",
    internalAmount: "210.00",
    agencyAdditional: "40.00",
    paymentRecipient: "excellent_staffing",
    importBatchId: null,
    importRowId: null,
    sourceFileId: null,
    matchStatus: "new",
    isGroup: false,
    serviceSessionId: null,
    groupDetectionStatus: "single",
    isPaid: false,
    paidAt: null,
    paidNote: null,
    ...overrides,
  };
}

describe("source-payment grouping", () => {
  it("keeps one agency source payment separate from its employee-check grain", () => {
    const rows = [
      transaction({ id: "e1-a", hours: "10", gross: "250", internalAmount: "210", agencyAdditional: "40" }),
      transaction({ id: "e1-b", individual: "Second Person", individualId: "individual-2", hours: "5", gross: "125", internalAmount: "105", agencyAdditional: "20" }),
      transaction({
        id: "e2-a",
        payTo: " excellent staffing, LLC ",
        employee: "Second Employee",
        employeeId: "employee-2",
        hours: "4",
        gross: "100",
        internalAmount: "84",
        agencyAdditional: "16",
      }),
    ];

    const payments = groupSourcePayments(rows);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      rows: 3,
      employeeChecks: 2,
      employees: ["First Employee", "Second Employee"],
      individuals: ["Second Person", "Test Individual"],
      hours: "19.00",
      funderBilled: "475.00",
      employeeBase: "399.00",
      agencySpread: "76.00",
      sourceNet: "46858.71",
      needsReview: false,
    });
    expect(computeGridTotals(rows)).toMatchObject({
      checks: 2,
      sourcePayments: 1,
      netPerCheck: "46858.71",
    });
  });

  it("does not present an arbitrary net when source rows disagree", () => {
    const payment = groupSourcePayments([
      transaction({ id: "first", totalNetPay: "100.00" }),
      transaction({ id: "second", totalNetPay: "101.00" }),
    ])[0]!;

    expect(payment.sourceNet).toBeNull();
    expect(payment.needsReview).toBe(true);
    expect(payment.reviewReasons).toContain("Source net values differ");
  });

  it("surfaces a partial Paid marker instead of treating the whole payment as paid", () => {
    const payment = groupSourcePayments([
      transaction({ id: "first", isPaid: true }),
      transaction({ id: "second", isPaid: false }),
    ])[0]!;

    expect(payment.paidStatus).toBe("mixed");
    expect(payment.reviewReasons).toContain("Paid status differs within payment");
  });

  it("keeps different payees and different period bounds as different source payments", () => {
    const rows = [
      transaction({ id: "base" }),
      transaction({ id: "other-payee", payTo: "Direct Employee" }),
      transaction({ id: "other-period", periodEnd: "2026-08-16" }),
    ];
    const payments = groupSourcePayments(rows);

    expect(payments).toHaveLength(3);
    expect(computeGridTotals(rows).sourcePayments).toBe(3);
  });

  it("drills through by stable source-payment identity despite harmless payee formatting", () => {
    const rows = [
      transaction({ id: "first", payTo: "Excellent Staffing" }),
      transaction({ id: "same", payTo: " excellent staffing, LLC " }),
      transaction({ id: "other", checkDate: "2026-08-22" }),
    ];
    const identity = sourcePaymentIdentity(rows[0]!)!;

    expect(filterTransactionsBySourcePaymentIdentity(rows, identity).map((row) => row.id)).toEqual(["first", "same"]);
  });

  it("excludes rows with no usable payment coordinates", () => {
    expect(groupSourcePayments([transaction({
      checkNumber: null,
      checkDate: null,
      periodBegin: null,
      periodEnd: null,
    })])).toEqual([]);
  });

  it("exposes the requested mode, exact drill guard, and same-view exports", () => {
    const workspace = readFileSync(resolve("src/components/transactions/billed-activity-workspace.tsx"), "utf8");
    const view = readFileSync(resolve("src/components/transactions/source-payments-view.tsx"), "utf8");

    expect(workspace).toContain('onClick={() => selectView("source-payments")}');
    expect(workspace).toContain('title: "Payroll checks"');
    expect(view).toContain('sourcePaymentIdentity: payment.key');
    expect(view).toContain('params.set("payToKey", normalizePayee(payment.payTo))');
    expect(view).toContain('title: "Source payments"');
    expect(view).toContain("rows: exportRows");
  });
});
