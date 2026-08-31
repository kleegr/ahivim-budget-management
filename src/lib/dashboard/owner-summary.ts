import { computeGridTotals, type GridTotals } from "@/lib/business/transaction-totals";
import {
  groupChecks,
  type CheckRouting,
  type CheckSummary,
} from "@/components/transactions/check-grouping";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import type { IndividualBudgetBoardRow } from "@/lib/data/queries";
import type { ProgramBudgetRecord } from "@/lib/data/program-budgets";
import type { StrategyGridRow } from "@/lib/manage/calculation-strategies";
import { dec } from "@/lib/money";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface OwnerActivitySelection {
  checkDateFrom: string | null;
  checkDateTo: string | null;
  individualId: string | null;
  employeeId: string | null;
  /** Exact Period Begin value from the payroll ledger. */
  payrollPeriod: string | null;
}

export interface OwnerActivityOption {
  value: string;
  label: string;
}

export interface OwnerActivityFilterOptions {
  individuals: OwnerActivityOption[];
  employees: OwnerActivityOption[];
  payrollPeriods: OwnerActivityOption[];
}

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
    mode: "latest" | "selection";
    latestCheckDate: string | null;
    contextCheckCount: number;
    contextTotals: GridTotals;
    contextHref: string;
    recentChecks: OwnerRecentCheck[];
  };
  budgets: {
    people: number;
    authorizations: number;
    authorizedHours: string;
    usedHours: string;
    remainingHours: string;
    billingWithoutBudget: number;
    source: "program_authorizations";
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

function cleanDate(value: string | null | undefined): string | null {
  return value && ISO_DATE.test(value) ? value : null;
}

export function normalizeOwnerActivitySelection(
  value: Partial<OwnerActivitySelection> | undefined,
): OwnerActivitySelection {
  const from = cleanDate(value?.checkDateFrom);
  const to = cleanDate(value?.checkDateTo);
  return {
    checkDateFrom: from && to && from > to ? to : from,
    checkDateTo: from && to && from > to ? from : to,
    individualId: value?.individualId?.trim() || null,
    employeeId: value?.employeeId?.trim() || null,
    payrollPeriod: cleanDate(value?.payrollPeriod),
  };
}

function hasActivitySelection(value: OwnerActivitySelection): boolean {
  return Boolean(
    value.checkDateFrom
      || value.checkDateTo
      || value.individualId
      || value.employeeId
      || value.payrollPeriod,
  );
}

function filterActivityRows(
  rows: GridTransaction[],
  selection: OwnerActivitySelection,
): GridTransaction[] {
  return rows.filter((row) => {
    if (selection.checkDateFrom && (!row.checkDate || row.checkDate < selection.checkDateFrom)) return false;
    if (selection.checkDateTo && (!row.checkDate || row.checkDate > selection.checkDateTo)) return false;
    if (selection.individualId && row.individualId !== selection.individualId) return false;
    if (selection.employeeId && row.employeeId !== selection.employeeId) return false;
    if (selection.payrollPeriod && row.periodBegin !== selection.payrollPeriod) return false;
    return true;
  });
}

function activityRowsHref(selection: OwnerActivitySelection): string {
  const params = new URLSearchParams({ view: "rows" });
  if (selection.checkDateFrom) params.set("checkDateFrom", selection.checkDateFrom);
  if (selection.checkDateTo) params.set("checkDateTo", selection.checkDateTo);
  if (selection.individualId) params.set("individualId", selection.individualId);
  if (selection.employeeId) params.set("employeeId", selection.employeeId);
  if (selection.payrollPeriod) {
    params.set("pbFrom", selection.payrollPeriod);
    params.set("pbTo", selection.payrollPeriod);
  }
  return `/transactions?${params.toString()}`;
}

function checkRowsHref(
  check: CheckSummary,
  selection?: OwnerActivitySelection,
): string {
  const params = new URLSearchParams({ view: "rows" });
  if (check.checkNumber) params.set("checkNumber", check.checkNumber);
  if (check.payTo) params.set("payToKey", check.payTo.trim().toLocaleLowerCase());
  else if (check.employeeId) params.set("employeeId", check.employeeId);
  else if (check.employee) params.set("employee", check.employee);
  if (check.checkDate) {
    params.set("checkDateFrom", check.checkDate);
    params.set("checkDateTo", check.checkDate);
  } else if (check.periodBegin || check.periodEnd) {
    if (check.periodBegin) {
      params.set("pbFrom", check.periodBegin);
      params.set("pbTo", check.periodBegin);
    }
  }
  if (selection?.individualId) params.set("individualId", selection.individualId);
  if (selection?.employeeId) params.set("employeeId", selection.employeeId);
  if (selection?.payrollPeriod) {
    params.set("pbFrom", selection.payrollPeriod);
    params.set("pbTo", selection.payrollPeriod);
  }
  return `/transactions?${params.toString()}`;
}

export function buildOwnerActivityFilterOptions(
  rows: GridTransaction[],
): OwnerActivityFilterOptions {
  const individuals = new Map<string, string>();
  const employees = new Map<string, string>();
  const periods = new Map<string, string | null>();

  for (const row of rows) {
    if (row.individualId && row.individual) individuals.set(row.individualId, row.individual);
    if (row.employeeId && row.employee) employees.set(row.employeeId, row.employee);
    if (row.periodBegin) {
      const knownEnd = periods.get(row.periodBegin);
      if (!knownEnd || (row.periodEnd && row.periodEnd > knownEnd)) periods.set(row.periodBegin, row.periodEnd);
    }
  }

  const peopleOptions = (values: Map<string, string>): OwnerActivityOption[] => [...values]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));

  return {
    individuals: peopleOptions(individuals),
    employees: peopleOptions(employees),
    payrollPeriods: [...periods]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([value, end]) => ({ value, label: end ? `${value} to ${end}` : value })),
  };
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
  const billingWithoutBudget = board.filter(
    (row) => !row.archived
      && row.status === "active"
      && row.hasBilling
      && !authorizedPeople.has(row.id),
  ).length;

  return {
    people: authorizedPeople.size,
    authorizations: hourAuthorizations.length,
    authorizedHours: sum(hourAuthorizations.map((row) => row.authorizedHours)),
    usedHours: sum(hourAuthorizations.map((row) => row.consumedHours)),
    remainingHours: sum(hourAuthorizations.map((row) => row.remainingHours)),
    billingWithoutBudget,
    source: "program_authorizations",
  };
}

export function buildOwnerDashboardSummary(input: {
  transactions: GridTransaction[];
  programBudgets: ProgramBudgetRecord[];
  budgetBoard: IndividualBudgetBoardRow[];
  strategies: StrategyGridRow[];
  activitySelection?: Partial<OwnerActivitySelection>;
}): OwnerDashboardSummary {
  const selection = normalizeOwnerActivitySelection(input.activitySelection);
  const selectionActive = hasActivitySelection(selection);
  const filteredRows = selectionActive
    ? filterActivityRows(input.transactions, selection)
    : input.transactions;
  const latestDate = latestCheckDate(filteredRows);
  const contextRows = selectionActive
    ? filteredRows
    : latestDate
      ? filteredRows.filter((row) => row.checkDate === latestDate)
      : [];

  const recentChecks = groupChecks(filteredRows)
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
      href: checkRowsHref(check, selectionActive ? selection : undefined),
    }));

  const approved = input.strategies.filter((row) => row.afterAll !== null);

  return {
    transactions: {
      mode: selectionActive ? "selection" : "latest",
      latestCheckDate: latestDate,
      contextCheckCount: groupChecks(contextRows).length,
      contextTotals: computeGridTotals(contextRows),
      contextHref: selectionActive
        ? activityRowsHref(selection)
        : latestDate
          ? activityRowsHref(normalizeOwnerActivitySelection({
              checkDateFrom: latestDate,
              checkDateTo: latestDate,
            }))
          : "/transactions",
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
