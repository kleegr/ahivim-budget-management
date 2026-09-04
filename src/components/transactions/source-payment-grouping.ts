import type { GridTransaction } from "@/lib/data/transactions-grid";
import {
  completeCheckIdentity,
  sourcePaymentIdentity,
} from "@/lib/business/transaction-totals";
import { dec } from "@/lib/money";
import { activityNextStep, activityNextStepLabel } from "@/lib/transactions/activity-state";

export type SourcePaymentPaidStatus = "paid" | "unpaid" | "mixed";

export interface SourcePaymentSummary {
  key: string;
  checkNumber: string | null;
  checkDate: string | null;
  payTo: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  employees: string[];
  employeeChecks: number;
  employeeCheckIdentities: string[];
  individuals: string[];
  programs: string[];
  hours: string;
  funderBilled: string;
  employeeBase: string;
  agencySpread: string;
  sourceNet: string | null;
  rows: number;
  transactionIds: string[];
  paidStatus: SourcePaymentPaidStatus;
  needsReview: boolean;
  reviewReasons: string[];
}

function hasAmount(value: string | null | undefined): value is string {
  return value !== null && value !== undefined;
}

/**
 * Project recorded-service rows onto the imported source-payment grain.
 *
 * One agency payment can cover several employee checks. The shared
 * sourcePaymentIdentity helper deliberately prefers the normalized Pay To value,
 * while employee-check count remains based on completeCheckIdentity. Keeping
 * both sets here prevents a repeated source net from being multiplied.
 */
export function groupSourcePayments(rows: GridTransaction[]): SourcePaymentSummary[] {
  const groups = new Map<string, GridTransaction[]>();
  for (const row of rows) {
    const key = sourcePaymentIdentity(row);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()].map(([key, group]) => {
    const first = group[0]!;
    let hours = dec(0);
    let funderBilled = dec(0);
    let employeeBase = dec(0);
    let agencySpread = dec(0);
    const employees = new Set<string>();
    const individuals = new Set<string>();
    const programs = new Set<string>();
    const employeeChecks = new Set<string>();
    const netValues = new Map<string, string>();
    const paidValues = new Set<boolean>();
    const reviewReasons = new Set<string>();

    for (const row of group) {
      if (hasAmount(row.hours)) hours = hours.plus(row.hours);
      if (hasAmount(row.gross)) funderBilled = funderBilled.plus(row.gross);
      if (hasAmount(row.internalAmount)) employeeBase = employeeBase.plus(row.internalAmount);
      if (hasAmount(row.agencyAdditional)) agencySpread = agencySpread.plus(row.agencyAdditional);
      if (row.employee) employees.add(row.employee);
      if (row.individual) individuals.add(row.individual);
      if (row.program) programs.add(row.program);
      const employeeCheck = completeCheckIdentity(row);
      if (employeeCheck) employeeChecks.add(employeeCheck);
      if (hasAmount(row.totalNetPay)) {
        const canonicalNet = dec(row.totalNetPay).toFixed(2);
        netValues.set(canonicalNet, canonicalNet);
      }
      paidValues.add(row.isPaid);
      if (activityNextStep(row) !== "ready") reviewReasons.add(activityNextStepLabel(row));
    }

    const payTo = group
      .map((row) => row.payTo?.trim() || null)
      .find((value): value is string => value !== null) ?? null;
    if (!first.checkNumber?.trim()) reviewReasons.add("Add check number");
    if (!payTo && employees.size === 0) reviewReasons.add("Confirm payment recipient");
    if (netValues.size === 0) reviewReasons.add("Add source net");
    if (netValues.size > 1) reviewReasons.add("Source net values differ");
    if (paidValues.size > 1) reviewReasons.add("Paid status differs within payment");

    const paidStatus: SourcePaymentPaidStatus = paidValues.size > 1
      ? "mixed"
      : paidValues.has(true)
        ? "paid"
        : "unpaid";

    return {
      key,
      checkNumber: first.checkNumber?.trim() || null,
      checkDate: first.checkDate,
      payTo,
      periodBegin: first.periodBegin,
      periodEnd: first.periodEnd,
      employees: [...employees].sort(),
      employeeChecks: employeeChecks.size,
      employeeCheckIdentities: [...employeeChecks],
      individuals: [...individuals].sort(),
      programs: [...programs].sort(),
      hours: hours.toFixed(2),
      funderBilled: funderBilled.toFixed(2),
      employeeBase: employeeBase.toFixed(2),
      agencySpread: agencySpread.toFixed(2),
      sourceNet: netValues.size === 1 ? [...netValues.values()][0]! : null,
      rows: group.length,
      transactionIds: group.map((row) => row.id),
      paidStatus,
      needsReview: reviewReasons.size > 0,
      reviewReasons: [...reviewReasons],
    };
  }).sort((a, b) => Number(b.needsReview) - Number(a.needsReview)
    || (b.checkDate ?? "").localeCompare(a.checkDate ?? "")
    || (a.payTo ?? "").localeCompare(b.payTo ?? "")
    || (a.checkNumber ?? "").localeCompare(b.checkNumber ?? ""));
}
