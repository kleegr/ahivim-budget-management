import type { GridTransaction } from "@/lib/data/transactions-grid";
import { completeCheckIdentity } from "@/lib/business/transaction-totals";
import { dec } from "@/lib/money";
import { activityNextStep, activityNextStepLabel } from "@/lib/transactions/activity-state";

export type CheckRouting = "direct" | "agency" | "review";

export interface CheckSummary {
  key: string;
  checkNumber: string | null;
  checkDate: string | null;
  employee: string | null;
  employeeId: string | null;
  payTo: string | null;
  routing: CheckRouting;
  periodBegin: string | null;
  periodEnd: string | null;
  individuals: string[];
  programs: string[];
  hours: string;
  funderBilled: string;
  employeeBase: string;
  agencySpread: string;
  netPay: string | null;
  verifiedCheckGross: string | null;
  verifiedCheckNet: string | null;
  withholding: string | null;
  verificationStatus: string | null;
  rows: number;
  transactionIds: string[];
  needsReview: boolean;
  reviewReasons: string[];
}

function hasAmount(value: string | null | undefined): value is string {
  return value !== null && value !== undefined;
}

export function checkGroupIdentity(row: Pick<
  GridTransaction,
  "employeeId" | "employee" | "checkNumber" | "checkDate" | "periodBegin" | "periodEnd"
>): string | null {
  return completeCheckIdentity(row);
}

export function groupChecks(rows: GridTransaction[]): CheckSummary[] {
  const groups = new Map<string, GridTransaction[]>();
  for (const row of rows) {
    const key = checkGroupIdentity(row);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()].map(([key, group]) => {
    const first = group[0];
    let hours = dec(0);
    let funderBilled = dec(0);
    let employeeBase = dec(0);
    let agencySpread = dec(0);
    const individuals = new Set<string>();
    const programs = new Set<string>();
    const recipients = new Set(group.map((row) => row.paymentRecipient).filter(Boolean));
    const employees = new Map<string, { id: string | null; name: string }>();
    const begins = group.map((row) => row.periodBegin).filter((value): value is string => Boolean(value)).sort();
    const ends = group.map((row) => row.periodEnd).filter((value): value is string => Boolean(value)).sort();
    const netValues = new Map<string, string>();
    const verifiedGrossValues = new Map<string, string>();
    const verifiedNetValues = new Map<string, string>();
    const withholdingValues = new Map<string, string>();
    const verificationStatuses = new Set<string>();
    const reviewReasons = new Set<string>();

    for (const row of group) {
      if (hasAmount(row.hours)) hours = hours.plus(row.hours);
      if (hasAmount(row.gross)) funderBilled = funderBilled.plus(row.gross);
      if (hasAmount(row.internalAmount)) employeeBase = employeeBase.plus(row.internalAmount);
      if (hasAmount(row.agencyAdditional)) agencySpread = agencySpread.plus(row.agencyAdditional);
      if (row.individual) individuals.add(row.individual);
      if (row.program) programs.add(row.program);
      if (row.employee) employees.set(row.employeeId ?? row.employee, { id: row.employeeId, name: row.employee });
      if (hasAmount(row.totalNetPay)) netValues.set(dec(row.totalNetPay).toString(), row.totalNetPay);
      if (row.verificationStatus) verificationStatuses.add(row.verificationStatus);
      if (row.verificationStatus === "verified") {
        if (hasAmount(row.verifiedCheckGross)) verifiedGrossValues.set(dec(row.verifiedCheckGross).toString(), row.verifiedCheckGross);
        if (hasAmount(row.verifiedCheckNet)) verifiedNetValues.set(dec(row.verifiedCheckNet).toString(), row.verifiedCheckNet);
        if (hasAmount(row.withholding)) withholdingValues.set(dec(row.withholding).toString(), row.withholding);
      }
      if (activityNextStep(row) !== "ready") reviewReasons.add(activityNextStepLabel(row));
    }

    const routing: CheckRouting = recipients.size === 1 && recipients.has("employee")
      ? "direct"
      : recipients.size === 1 && recipients.has("excellent_staffing")
        ? "agency"
        : "review";
    if (!first.checkNumber?.trim()) reviewReasons.add("Add check number");
    if (employees.size > 1) reviewReasons.add("Confirm employee");
    if (routing === "review") reviewReasons.add("Confirm payment recipient");
    if (routing === "direct" && netValues.size === 0) reviewReasons.add("Add check net");
    if (netValues.size > 1) reviewReasons.add("Check net values differ");
    if (verificationStatuses.size > 1) reviewReasons.add("Check verification statuses differ");
    if (verifiedGrossValues.size > 1) reviewReasons.add("Verified check gross values differ");
    if (verifiedNetValues.size > 1) reviewReasons.add("Verified check net values differ");
    if (withholdingValues.size > 1) reviewReasons.add("Withholding values differ");

    return {
      key,
      checkNumber: first.checkNumber?.trim() || null,
      checkDate: first.checkDate,
      employee: employees.size > 1 ? "Multiple employees" : first.employee,
      employeeId: employees.size > 1 ? null : first.employeeId,
      payTo: first.payTo,
      routing,
      periodBegin: begins[0] ?? null,
      periodEnd: ends.at(-1) ?? null,
      individuals: [...individuals].sort(),
      programs: [...programs].sort(),
      hours: hours.toFixed(2),
      funderBilled: funderBilled.toFixed(2),
      employeeBase: employeeBase.toFixed(2),
      agencySpread: agencySpread.toFixed(2),
      netPay: routing === "direct" ? ([...netValues.values()][0] ?? null) : null,
      verifiedCheckGross: [...verifiedGrossValues.values()][0] ?? null,
      verifiedCheckNet: [...verifiedNetValues.values()][0] ?? null,
      withholding: [...withholdingValues.values()][0] ?? null,
      verificationStatus: verificationStatuses.size === 1 ? [...verificationStatuses][0]! : null,
      rows: group.length,
      transactionIds: group.map((row) => row.id),
      needsReview: reviewReasons.size > 0,
      reviewReasons: [...reviewReasons],
    };
  }).sort((a, b) => Number(b.needsReview) - Number(a.needsReview)
    || (b.checkDate ?? "").localeCompare(a.checkDate ?? "")
    || (a.employee ?? "").localeCompare(b.employee ?? ""));
}
