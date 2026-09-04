import { dec } from "@/lib/money";
import { normalizePersonName } from "@/lib/business/name-matching";

/**
 * Excel-SUBTOTAL-style totals for the Transactions grid, computed over whatever
 * set of rows is currently visible (i.e. after filtering). Pure and
 * decimal-safe so it can be unit-tested against the workbook and reused by the
 * client grid.
 *
 * Reproduces the workbook's logic exactly:
 *   - gross / internal / agency-additional / hours are simple column sums;
 *   - agency additional per row is gross − internal (workbook column R = Q − P),
 *     already carried on each row, so the total can be negative or positive;
 *   - check-level values are counted once per complete payment identity:
 *     employee + normalized check number + check date + both period bounds.
 *     Payee text is not identity, and fully unidentified rows do not create a
 *     synthetic check.
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
  individuals: number;
  employees: number;
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
  const payments = new Set<string>();
  const inds = new Set<string>();
  const emps = new Set<string>();
  const seenNetPayment = new Set<string>();
  const seenVerifiedGross = new Set<string>();
  const seenVerifiedNet = new Set<string>();
  const seenWithholding = new Set<string>();

  for (const r of rows) {
    if (r.gross) gross = gross.plus(dec(r.gross));
    if (r.internalAmount) internal = internal.plus(dec(r.internalAmount));
    if (r.agencyAdditional) addl = addl.plus(dec(r.agencyAdditional));
    if (r.hours) hours = hours.plus(dec(r.hours));
    const paymentKey = completeCheckIdentity(r);
    if (paymentKey) payments.add(paymentKey);
    const indKey = r.individualId ?? r.individual;
    if (indKey) inds.add(indKey);
    const empKey = r.employeeId ?? r.employee;
    if (empKey) emps.add(empKey);

    // Net pay is repeated on every row belonging to one payment. Count the
    // first populated value once; rows with no usable check identity are not a
    // check and do not contribute check-level values.
    if (paymentKey && r.totalNetPay && !seenNetPayment.has(paymentKey)) {
      seenNetPayment.add(paymentKey);
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
    checks: payments.size,
    individuals: inds.size,
    employees: emps.size,
  };
}
