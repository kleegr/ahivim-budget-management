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
 *   - Total Net Pay is counted ONCE per check number (the workbook's column-S
 *     rule), never repeated for every row of the same check.
 */
export interface TotalsInput {
  id: string;
  gross: string | null;
  internalAmount: string | null;
  agencyAdditional: string | null;
  hours: string | null;
  totalNetPay: string | null;
  checkNumber: string | null;
  individualId: string | null;
  individual: string | null;
  employeeId: string | null;
  employee: string | null;
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
  const checks = new Set<string>();
  const inds = new Set<string>();
  const emps = new Set<string>();
  const seenCheck = new Set<string>();

  for (const r of rows) {
    if (r.gross) gross = gross.plus(dec(r.gross));
    if (r.internalAmount) internal = internal.plus(dec(r.internalAmount));
    if (r.agencyAdditional) addl = addl.plus(dec(r.agencyAdditional));
    if (r.hours) hours = hours.plus(dec(r.hours));
    if (r.checkNumber) checks.add(r.checkNumber);
    const indKey = r.individualId ?? r.individual;
    if (indKey) inds.add(indKey);
    const empKey = r.employeeId ?? r.employee;
    if (empKey) emps.add(empKey);

    // Net pay is a per-check figure repeated on every row of the check; count it once.
    const ck = r.checkNumber ?? `row:${r.id}`;
    if (!seenCheck.has(ck)) {
      seenCheck.add(ck);
      if (r.totalNetPay) net = net.plus(dec(r.totalNetPay));
    }
  }

  return {
    gross: gross.toFixed(2),
    internal: internal.toFixed(2),
    agencyAdditional: addl.toFixed(2),
    hours: hours.toFixed(2),
    netPerCheck: net.toFixed(2),
    transactions: rows.length,
    checks: checks.size,
    individuals: inds.size,
    employees: emps.size,
  };
}
