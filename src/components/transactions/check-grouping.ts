import type { GridTransaction } from "@/lib/data/transactions-grid";
import { dec } from "@/lib/money";

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
  rows: number;
  transactionIds: string[];
}

export function checkGroupIdentity(row: Pick<
  GridTransaction,
  "id" | "payTo" | "employeeId" | "employee" | "checkNumber" | "checkDate" | "periodBegin" | "periodEnd"
>): string {
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

export function groupChecks(rows: GridTransaction[]): CheckSummary[] {
  const groups = new Map<string, GridTransaction[]>();
  for (const row of rows) {
    const key = checkGroupIdentity(row);
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

    for (const row of group) {
      if (row.hours) hours = hours.plus(row.hours);
      if (row.gross) funderBilled = funderBilled.plus(row.gross);
      if (row.internalAmount) employeeBase = employeeBase.plus(row.internalAmount);
      if (row.agencyAdditional) agencySpread = agencySpread.plus(row.agencyAdditional);
      if (row.individual) individuals.add(row.individual);
      if (row.program) programs.add(row.program);
      if (row.employee) employees.set(row.employeeId ?? row.employee, { id: row.employeeId, name: row.employee });
    }

    const routing: CheckRouting = recipients.size === 1 && recipients.has("employee")
      ? "direct"
      : recipients.size === 1 && recipients.has("excellent_staffing")
        ? "agency"
        : "review";

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
      netPay: routing === "direct" ? first.totalNetPay : null,
      rows: group.length,
      transactionIds: group.map((row) => row.id),
    };
  }).sort((a, b) => (b.checkDate ?? "").localeCompare(a.checkDate ?? "") || (a.employee ?? "").localeCompare(b.employee ?? ""));
}
