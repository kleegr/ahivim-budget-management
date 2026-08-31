import { computeGridTotals, type GridTotals } from "@/lib/business/transaction-totals";
import {
  checkGroupIdentity,
  groupChecks,
  type CheckRouting,
  type CheckSummary,
} from "@/components/transactions/check-grouping";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import type { IndividualBudgetBoardRow } from "@/lib/data/queries";
import type { ProgramBudgetRecord } from "@/lib/data/program-budgets";
import type { StrategyGridRow } from "@/lib/manage/calculation-strategies";
import { dec } from "@/lib/money";

const MAX_EXACT_TRANSACTION_LINK_ROWS = 200;

export interface OwnerRecentCheck {
  key: string;
  checkDate: string | null;
  checkNumber: string | null;
  employee: string | null;
  payTo: string | null;
  routing: CheckRouting;
  individuals: number;
  programs: number;
  rows: number;
  hours: string;
  funderBilled: string;
  employeeBase: string;
  agencySpread: string;
  netPay: string | null;
  href: string;
}

export interface OwnerDashboardSummary {
  transactions: {
    latestCheckDate: string | null;
    latestCheckCount: number;
    latestTotals: GridTotals;
    latestHref: string;
    recentChecks: OwnerRecentCheck[];
  };
  budgets: {
    people: number;
    authorizations: number;
    authorizedHours: string;
    usedHours: string;
    remainingHours: string;
    billingWithoutBudget: number;
    source: "program_authorizations" | "budget_board" | "mixed";
  };
  financial: {
    strategies: number;
    yearlyGross: string;
    monthlyGross: string;
    calculatedNet: string;
    approvedFinal: string;
    approvedStrategies: number;
  };
}

function exactTransactionHref(rows: Pick<GridTransaction, "id">[], fallback = "/transactions"): string {
  if (rows.length === 0 || rows.length > MAX_EXACT_TRANSACTION_LINK_ROWS) return fallback;
  const params = new URLSearchParams();
  for (const row of rows) params.append("transactionId", row.id);
  return `/transactions?${params.toString()}`;
}

function checkRowsHref(check: CheckSummary): string {
  const params = new URLSearchParams({ view: "rows" });
  if (check.checkNumber) params.set("checkNumber", check.checkNumber);
  if (check.payTo) params.set("payToKey", check.payTo.trim().toLocaleLowerCase());
  else if (check.employeeId) params.set("employeeId", check.employeeId);
  else if (check.employee) params.set("employee", check.employee);
  if (check.checkDate) params.set("period", `${check.checkDate}..${check.checkDate}`);
  else if (check.periodBegin || check.periodEnd) {
    params.set("period", `${check.periodBegin ?? ""}..${check.periodEnd ?? ""}`);
  }
  return `/transactions?${params.toString()}`;
}

function sum(values: Array<string | number | null | undefined>): string {
  return values.reduce((total, value) => total.plus(dec(value)), dec(0)).toFixed(2);
}

function latestCheckDate(rows: GridTransaction[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (row.checkDate && (latest === null || row.checkDate > latest)) latest = row.checkDate;
  }
  return latest;
}

function summarizeBudgets(
  programBudgets: ProgramBudgetRecord[],
  board: IndividualBudgetBoardRow[],
): OwnerDashboardSummary["budgets"] {
  const hourAuthorizations = programBudgets.filter(
    (row) => row.requiredAuthType === "hours" || row.requiredAuthType === "both",
  );
  const authorizedPeople = new Set(hourAuthorizations.map((row) => row.individualId));
  const fallbackBudgets = board.filter(
    (row) => !row.archived
      && row.status === "active"
      && row.budget
      && !authorizedPeople.has(row.id),
  );
  const billingWithoutBudget = board.filter(
    (row) => !row.archived
      && row.hasBilling
      && row.budget === null
      && !authorizedPeople.has(row.id),
  ).length;

  if (hourAuthorizations.length > 0 || fallbackBudgets.length > 0) {
    return {
      people: authorizedPeople.size + fallbackBudgets.length,
      authorizations: hourAuthorizations.length
        + fallbackBudgets.reduce((total, row) => total + (row.budget?.plans ?? 0), 0),
      authorizedHours: sum([
        ...hourAuthorizations.map((row) => row.authorizedHours),
        ...fallbackBudgets.map((row) => row.budget
          ? dec(row.budget.usedHours).plus(row.budget.hoursLeft ?? 0).toString()
          : "0"),
      ]),
      usedHours: sum([
        ...hourAuthorizations.map((row) => row.consumedHours),
        ...fallbackBudgets.map((row) => row.budget?.usedHours ?? 0),
      ]),
      remainingHours: sum([
        ...hourAuthorizations.map((row) => row.remainingHours),
        ...fallbackBudgets.map((row) => row.budget?.hoursLeft ?? 0),
      ]),
      billingWithoutBudget,
      source: hourAuthorizations.length > 0 && fallbackBudgets.length > 0
        ? "mixed"
        : hourAuthorizations.length > 0
          ? "program_authorizations"
          : "budget_board",
    };
  }

  const activeBudgets = fallbackBudgets;
  return {
    people: activeBudgets.length,
    authorizations: activeBudgets.reduce((total, row) => total + (row.budget?.plans ?? 0), 0),
    authorizedHours: sum(activeBudgets.map((row) => {
      const budget = row.budget;
      return budget ? dec(budget.usedHours).plus(budget.hoursLeft ?? 0).toString() : "0";
    })),
    usedHours: sum(activeBudgets.map((row) => row.budget?.usedHours ?? 0)),
    remainingHours: sum(activeBudgets.map((row) => row.budget?.hoursLeft ?? 0)),
    billingWithoutBudget,
    source: "budget_board",
  };
}

export function buildOwnerDashboardSummary(input: {
  transactions: GridTransaction[];
  programBudgets: ProgramBudgetRecord[];
  budgetBoard: IndividualBudgetBoardRow[];
  strategies: StrategyGridRow[];
}): OwnerDashboardSummary {
  const latestDate = latestCheckDate(input.transactions);
  const latestRows = latestDate
    ? input.transactions.filter((row) => row.checkDate === latestDate)
    : [];
  const rowsByCheck = new Map<string, GridTransaction[]>();
  for (const row of input.transactions) {
    const key = checkGroupIdentity(row);
    const existing = rowsByCheck.get(key);
    if (existing) existing.push(row);
    else rowsByCheck.set(key, [row]);
  }

  const recentChecks = groupChecks(input.transactions)
    .filter((check) => check.checkDate !== null)
    .slice(0, 5)
    .map((check) => ({
      key: check.key,
      checkDate: check.checkDate,
      checkNumber: check.checkNumber,
      employee: check.employee,
      payTo: check.payTo,
      routing: check.routing,
      individuals: check.individuals.length,
      programs: check.programs.length,
      rows: check.rows,
      hours: check.hours,
      funderBilled: check.funderBilled,
      employeeBase: check.employeeBase,
      agencySpread: check.agencySpread,
      netPay: check.netPay,
      href: exactTransactionHref(rowsByCheck.get(check.key) ?? [], checkRowsHref(check)),
    }));

  const approved = input.strategies.filter((row) => row.afterAll !== null);

  return {
    transactions: {
      latestCheckDate: latestDate,
      latestCheckCount: groupChecks(latestRows).length,
      latestTotals: computeGridTotals(latestRows),
      latestHref: exactTransactionHref(
        latestRows,
        latestDate ? `/transactions?view=rows&period=${latestDate}..${latestDate}` : "/transactions",
      ),
      recentChecks,
    },
    budgets: summarizeBudgets(input.programBudgets, input.budgetBoard),
    financial: {
      strategies: input.strategies.length,
      yearlyGross: sum(input.strategies.map((row) => row.yearlyGross)),
      monthlyGross: sum(input.strategies.map((row) => row.monthlyGross)),
      calculatedNet: sum(input.strategies.map((row) => row.net)),
      approvedFinal: sum(approved.map((row) => row.afterAll)),
      approvedStrategies: approved.length,
    },
  };
}
