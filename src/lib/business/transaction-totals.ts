import { dec } from "@/lib/money";

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
 *   - Total Net Pay is counted once per real payment. Check numbers can be
 *     reused, so payment identity also includes the payee and check date
 *     (or the service period when the check date is missing).
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
}

function paymentIdentity(row: TotalsInput): string {
  const payeeKey = row.payTo?.trim().toLocaleLowerCase()
    || row.employeeId
    || row.employee?.trim().toLocaleLowerCase()
    || "unknown-payee";
  const checkNumber = row.checkNumber?.trim() || null;
  if (!checkNumber) return `${payeeKey}:row:${row.id}`;

  const timing = row.checkDate
    ? `date:${row.checkDate}`
    : row.periodBegin || row.periodEnd
      ? `period:${row.periodBegin ?? ""}:${row.periodEnd ?? ""}`
      : "undated";
  return `${payeeKey}:check:${checkNumber}:${timing}`;
}

export interface GridTotals {
  gross: string;
  internal: string;
  agencyAdditional: string;
  hours: string;
  netPerCheck: string;
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
  const payments = new Set<string>();
  const inds = new Set<string>();
  const emps = new Set<string>();
  const seenNetPayment = new Set<string>();

  for (const r of rows) {
    if (r.gross) gross = gross.plus(dec(r.gross));
    if (r.internalAmount) internal = internal.plus(dec(r.internalAmount));
    if (r.agencyAdditional) addl = addl.plus(dec(r.agencyAdditional));
    if (r.hours) hours = hours.plus(dec(r.hours));
    const paymentKey = paymentIdentity(r);
    payments.add(paymentKey);
    const indKey = r.individualId ?? r.individual;
    if (indKey) inds.add(indKey);
    const empKey = r.employeeId ?? r.employee;
    if (empKey) emps.add(empKey);

    // Net pay is repeated on every row belonging to one payment. Count the
    // first populated value once while keeping rows without a number separate.
    if (r.totalNetPay && !seenNetPayment.has(paymentKey)) {
      seenNetPayment.add(paymentKey);
      net = net.plus(dec(r.totalNetPay));
    }
  }

  return {
    gross: gross.toFixed(2),
    internal: internal.toFixed(2),
    agencyAdditional: addl.toFixed(2),
    hours: hours.toFixed(2),
    netPerCheck: net.toFixed(2),
    transactions: rows.length,
    checks: payments.size,
    individuals: inds.size,
    employees: emps.size,
  };
}
