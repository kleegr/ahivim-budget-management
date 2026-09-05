import { dec } from "@/lib/money";
import { normalizePersonName } from "@/lib/business/name-matching";
import { normalizePayee } from "@/lib/business/internal-rate";

/**
 * Excel-SUBTOTAL-style totals for the Transactions grid, computed over whatever
 * set of rows is currently visible (i.e. after filtering). Pure and
 * decimal-safe so it can be unit-tested against the workbook and reused by the
 * client grid.
 *
 * Reproduces the workbook's logic while preserving the application's stronger
 * check identity:
 *   - gross / internal / agency-additional reconcile over the same complete
 *     rows (both gross and canonical Employee base are known);
 *   - agency additional is derived as gross − internal (workbook column R = Q − P),
 *     so stale/floored stored values cannot change the total;
 *   - incomplete money rows are counted explicitly rather than treating an
 *     unknown Employee base as zero;
 *   - hours remain a simple column sum;
 *   - checks and verified check facts are counted once per complete check identity:
 *     employee + normalized check number + check date + both period bounds.
 *     Payee text is not part of that identity;
 *   - imported source net is counted once per source payment identity. That
 *     identity prefers normalized pay-to (so one agency payment spanning
 *     several employees is not multiplied), then falls back to employee, and
 *     retains the check date plus both period bounds. Rows without any payment
 *     coordinates do not create a synthetic payment.
 */
export interface TotalsInput {
  id: string;
  gross: string | null;
  internalAmount: string | null;
  agencyAdditional: string | null;
  hours: string | null;
  totalNetPay: string | null;
  payTo: string | null;
  checkNumber: string | null;
  checkDate: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  individualId: string | null;
  individual: string | null;
  employeeId: string | null;
  employee: string | null;
  verifiedCheckGross?: string | null;
  verifiedCheckNet?: string | null;
  withholding?: string | null;
  verificationStatus?: string | null;
}

export type CompleteCheckIdentityInput = Pick<
  TotalsInput,
  "employeeId" | "employee" | "checkNumber" | "checkDate" | "periodBegin" | "periodEnd"
>;

export type SourcePaymentIdentityInput = Pick<
  TotalsInput,
  "payTo" | "employeeId" | "employee" | "checkNumber" | "checkDate" | "periodBegin" | "periodEnd"
>;

/** Stable complete check identity shared by row totals and Check mode. */
export function completeCheckIdentity(row: CompleteCheckIdentityInput): string | null {
  const checkNumber = row.checkNumber?.trim() || "";
  const checkDate = row.checkDate ?? "";
  const periodBegin = row.periodBegin ?? "";
  const periodEnd = row.periodEnd ?? "";
  if (!checkNumber && !checkDate && !periodBegin && !periodEnd) return null;
  const normalizedEmployee = normalizePersonName(row.employee);
  const employeeKey = row.employeeId
    ? `id:${row.employeeId}`
    : normalizedEmployee
      ? `name:${normalizedEmployee}`
      : "unknown";
  return JSON.stringify([employeeKey, checkNumber, checkDate, periodBegin, periodEnd]);
}

/** Identity of one imported source payment, which can cover multiple employee checks. */
export function sourcePaymentIdentity(row: SourcePaymentIdentityInput): string | null {
  const checkNumber = row.checkNumber?.trim() || "";
  const checkDate = row.checkDate ?? "";
  const periodBegin = row.periodBegin ?? "";
  const periodEnd = row.periodEnd ?? "";
  if (!checkNumber && !checkDate && !periodBegin && !periodEnd) return null;

  const normalizedPayTo = normalizePayee(row.payTo);
  const normalizedEmployee = normalizePersonName(row.employee);
  const recipientKey = normalizedPayTo
    ? `pay-to:${normalizedPayTo}`
    : row.employeeId
      ? `employee-id:${row.employeeId}`
      : normalizedEmployee
        ? `employee-name:${normalizedEmployee}`
        : "unknown";

  return JSON.stringify([recipientKey, checkNumber, checkDate, periodBegin, periodEnd]);
}

export interface GridTotals {
  gross: string;
  internal: string;
  agencyAdditional: string;
  hours: string;
  netPerCheck: string;
  verifiedCheckGross: string;
  verifiedCheckNet: string;
  withholding: string;
  transactions: number;
  checks: number;
  sourcePayments: number;
  individuals: number;
  employees: number;
  moneyExcludedRows: number;
}

export function computeGridTotals(rows: TotalsInput[]): GridTotals {
  let gross = dec(0);
  let internal = dec(0);
  let addl = dec(0);
  let hours = dec(0);
  let net = dec(0);
  let verifiedGross = dec(0);
  let verifiedNet = dec(0);
  let withholding = dec(0);
  const checks = new Set<string>();
  const sourcePayments = new Set<string>();
  const inds = new Set<string>();
  const emps = new Set<string>();
  const seenNetPayment = new Set<string>();
  const seenVerifiedGross = new Set<string>();
  const seenVerifiedNet = new Set<string>();
  const seenWithholding = new Set<string>();
  let moneyExcludedRows = 0;

  for (const r of rows) {
    if (r.gross !== null && r.internalAmount !== null) {
      const rowGross = dec(r.gross);
      const rowInternal = dec(r.internalAmount);
      gross = gross.plus(rowGross);
      internal = internal.plus(rowInternal);
      addl = addl.plus(rowGross.minus(rowInternal));
    } else {
      moneyExcludedRows += 1;
    }
    if (r.hours) hours = hours.plus(dec(r.hours));
    const paymentKey = completeCheckIdentity(r);
    if (paymentKey) checks.add(paymentKey);
    const indKey = r.individualId ?? r.individual;
    if (indKey) inds.add(indKey);
    const empKey = r.employeeId ?? r.employee;
    if (empKey) emps.add(empKey);

    // Imported net pay can be repeated across several employee checks that
    // belong to one source payment. Deduplicate it at the source-payment grain;
    // verified facts below deliberately remain at the complete-check grain.
    const sourcePaymentKey = sourcePaymentIdentity(r);
    if (sourcePaymentKey) sourcePayments.add(sourcePaymentKey);
    if (sourcePaymentKey && r.totalNetPay && !seenNetPayment.has(sourcePaymentKey)) {
      seenNetPayment.add(sourcePaymentKey);
      net = net.plus(dec(r.totalNetPay));
    }
    if (paymentKey && r.verificationStatus === "verified") {
      if (r.verifiedCheckGross && !seenVerifiedGross.has(paymentKey)) {
        seenVerifiedGross.add(paymentKey);
        verifiedGross = verifiedGross.plus(dec(r.verifiedCheckGross));
      }
      if (r.verifiedCheckNet && !seenVerifiedNet.has(paymentKey)) {
        seenVerifiedNet.add(paymentKey);
        verifiedNet = verifiedNet.plus(dec(r.verifiedCheckNet));
      }
      if (r.withholding && !seenWithholding.has(paymentKey)) {
        seenWithholding.add(paymentKey);
        withholding = withholding.plus(dec(r.withholding));
      }
    }
  }

  return {
    gross: gross.toFixed(2),
    internal: internal.toFixed(2),
    agencyAdditional: addl.toFixed(2),
    hours: hours.toFixed(2),
    netPerCheck: net.toFixed(2),
    verifiedCheckGross: verifiedGross.toFixed(2),
    verifiedCheckNet: verifiedNet.toFixed(2),
    withholding: withholding.toFixed(2),
    transactions: rows.length,
    checks: checks.size,
    sourcePayments: sourcePayments.size,
    individuals: inds.size,
    employees: emps.size,
    moneyExcludedRows,
  };
}
