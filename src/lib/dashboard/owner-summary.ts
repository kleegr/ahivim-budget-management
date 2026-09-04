import { computeGridTotals, type GridTotals } from "@/lib/business/transaction-totals";
import {
  groupChecks,
  type CheckRouting,
  type CheckSummary,
} from "@/components/transactions/check-grouping";
import type { GridTransaction } from "@/lib/data/transactions-grid";
import type { IndividualBudgetBoardRow } from "@/lib/data/queries";
import type { ProgramBudgetRecord } from "@/lib/data/program-budgets";
import { summarizeAuthorizationPortfolio } from "@/lib/data/authorization-portfolio";
import type { StrategyGridRow } from "@/lib/manage/calculation-strategies";
import { dec, formatMoney } from "@/lib/money";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface OwnerActivitySelection {
  checkDateFrom: string | null;
  checkDateTo: string | null;
  individualIds: string[];
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
    overLimit: number;
    atLimit: number;
    behindPace: number;
    scheduledOverLimit: number;
    renewalDueSoon: number;
    renewalMissing: number;
    renewalExpired: number;
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

export interface OwnerAttentionMoney {
  agencyOwes: string;
  employeesOwe: string;
  reservesToSetAside: string;
  credits: string;
  creditCount: number;
}

export interface OwnerAttentionItem {
  key: string;
  category: "Budget" | "Renewal" | "Schedule" | "Check" | "Money" | "Setup";
  title: string;
  detail: string;
  href: string;
  action: string;
}

function cleanDate(value: string | null | undefined): string | null {
  return value && ISO_DATE.test(value) ? value : null;
}

export function normalizeOwnerActivitySelection(
  value: (Partial<OwnerActivitySelection> & { individualId?: string | null }) | undefined,
): OwnerActivitySelection {
  const from = cleanDate(value?.checkDateFrom);
  const to = cleanDate(value?.checkDateTo);
  const individualIds = [...new Set([
    ...(value?.individualIds ?? []),
    value?.individualId ?? "",
  ].map((id) => id.trim()).filter(Boolean))];
  return {
    checkDateFrom: from && to && from > to ? to : from,
    checkDateTo: from && to && from > to ? from : to,
    individualIds,
    employeeId: value?.employeeId?.trim() || null,
    payrollPeriod: cleanDate(value?.payrollPeriod),
  };
}

function hasActivitySelection(value: OwnerActivitySelection): boolean {
  return Boolean(
    value.checkDateFrom
      || value.checkDateTo
      || value.individualIds.length > 0
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
    if (selection.individualIds.length > 0 && (!row.individualId || !selection.individualIds.includes(row.individualId))) return false;
    if (selection.employeeId && row.employeeId !== selection.employeeId) return false;
    if (selection.payrollPeriod && row.periodBegin !== selection.payrollPeriod) return false;
    return true;
  });
}

function activityRowsHref(selection: OwnerActivitySelection): string {
  const params = new URLSearchParams({ view: "rows" });
  if (selection.checkDateFrom) params.set("checkDateFrom", selection.checkDateFrom);
  if (selection.checkDateTo) params.set("checkDateTo", selection.checkDateTo);
  for (const individualId of selection.individualIds) params.append("individualId", individualId);
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
  for (const individualId of selection?.individualIds ?? []) params.append("individualId", individualId);
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
  strategies: StrategyGridRow[],
  asOf: Date,
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
  const activePeople = new Set(board
    .filter((row) => !row.archived && row.status === "active")
    .map((row) => row.id));
  const portfolio = [...summarizeAuthorizationPortfolio(hourAuthorizations, asOf).values()]
    .filter((row) => activePeople.has(row.individualId));
  const missingRenewalPeople = new Set(
    portfolio
      .filter((row) => row.budget.missingRenewal)
      .map((row) => row.individualId),
  );
  for (const strategy of strategies) {
    if (strategy.active && strategy.status === "active" && !strategy.renewalDate) {
      missingRenewalPeople.add(strategy.individualId);
    }
  }

  return {
    people: authorizedPeople.size,
    authorizations: hourAuthorizations.length,
    authorizedHours: sum(hourAuthorizations.map((row) => row.authorizedHours)),
    usedHours: sum(hourAuthorizations.map((row) => row.consumedHours)),
    remainingHours: sum(hourAuthorizations.map((row) => row.remainingHours)),
    billingWithoutBudget,
    overLimit: portfolio.filter((row) => row.budget.status === "over_authorization"
      || row.budget.plainStatus === "over").length,
    atLimit: portfolio.filter((row) => row.budget.status === "fully_used"
      || row.budget.status === "near_exhaustion").length,
    behindPace: portfolio.filter((row) => row.budget.status === "behind_pace").length,
    scheduledOverLimit: portfolio.filter((row) => (row.budget.hoursAfterScheduled ?? 0) < 0
      && (row.budget.hoursLeft ?? 0) >= 0).length,
    renewalDueSoon: portfolio.filter((row) => row.budget.daysToRenewal !== null
      && row.budget.daysToRenewal >= 0
      && row.budget.daysToRenewal <= 60).length,
    renewalMissing: missingRenewalPeople.size,
    renewalExpired: portfolio.filter((row) => row.budget.expired).length,
    source: "program_authorizations",
  };
}

export function buildOwnerDashboardSummary(input: {
  transactions: GridTransaction[];
  programBudgets: ProgramBudgetRecord[];
  budgetBoard: IndividualBudgetBoardRow[];
  strategies: StrategyGridRow[];
  asOf?: Date;
  activitySelection?: Partial<OwnerActivitySelection> & { individualId?: string | null };
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
    budgets: summarizeBudgets(
      input.programBudgets,
      input.budgetBoard,
      input.strategies,
      input.asOf ?? new Date(),
    ),
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

function plural(value: number, singular: string, pluralValue = `${singular}s`): string {
  return value === 1 ? singular : pluralValue;
}

function joinSignals(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

/**
 * Turn data already loaded for Owner Home into a short, prioritized work list.
 * Money is optional so budget/check/setup follow-up remains available when the
 * isolated actual-money read fails.
 */
export function buildOwnerAttentionItems(
  summary: OwnerDashboardSummary,
  money?: OwnerAttentionMoney,
  canonicalCheckIssueCount = 0,
): OwnerAttentionItem[] {
  const items: OwnerAttentionItem[] = [];
  const budgetSignals = [
    summary.budgets.overLimit > 0
      ? `${summary.budgets.overLimit.toLocaleString()} over the hour limit`
      : null,
    summary.budgets.atLimit > 0
      ? `${summary.budgets.atLimit.toLocaleString()} at or near the hour limit`
      : null,
    summary.budgets.behindPace > 0
      ? `${summary.budgets.behindPace.toLocaleString()} behind planned pace`
      : null,
    summary.budgets.billingWithoutBudget > 0
      ? `${summary.budgets.billingWithoutBudget.toLocaleString()} with billing but no active hour budget`
      : null,
  ].filter((value): value is string => value !== null);

  if (budgetSignals.length > 0) {
    const singleHref = summary.budgets.overLimit > 0
      ? "/individuals?view=over"
      : summary.budgets.atLimit > 0
        ? "/individuals?view=at_limit"
        : summary.budgets.behindPace > 0
          ? "/individuals?view=behind"
          : "/individuals?view=billing_without_budget";
    items.push({
      key: "budget-exceptions",
      category: "Budget",
      title: "Current budgets need review",
      detail: `${joinSignals(budgetSignals)}.`,
      href: budgetSignals.length === 1 ? singleHref : "/individuals?view=attention",
      action: "Review people & budgets",
    });
  }

  const renewalSignals = [
    summary.budgets.renewalExpired > 0
      ? `${summary.budgets.renewalExpired.toLocaleString()} expired`
      : null,
    summary.budgets.renewalMissing > 0
      ? `${summary.budgets.renewalMissing.toLocaleString()} missing a renewal date`
      : null,
    summary.budgets.renewalDueSoon > 0
      ? `${summary.budgets.renewalDueSoon.toLocaleString()} due within 60 days`
      : null,
  ].filter((value): value is string => value !== null);
  if (renewalSignals.length > 0) {
    items.push({
      key: "renewal-exceptions",
      category: "Renewal",
      title: "Renewals need follow-up",
      detail: `${joinSignals(renewalSignals)}.`,
      href: summary.budgets.renewalExpired === 0 && summary.budgets.renewalMissing === 0
        ? "/individuals?view=renewing"
        : "/individuals?view=attention",
      action: "Review renewals",
    });
  }

  if (summary.budgets.scheduledOverLimit > 0) {
    const count = summary.budgets.scheduledOverLimit;
    items.push({
      key: "scheduled-over-limit",
      category: "Schedule",
      title: "Future schedules exceed available hours",
      detail: `${count.toLocaleString()} ${plural(count, "person", "people")} ${plural(count, "has", "have")} more scheduled than the current authorization can cover.`,
      href: "/schedule?view=coverage",
      action: "Review coverage",
    });
  }

  if (canonicalCheckIssueCount > 0) {
    const count = canonicalCheckIssueCount;
    items.push({
      key: "check-verification",
      category: "Check",
      title: "Payroll checks need verification",
      detail: `${count.toLocaleString()} ${plural(count, "check group")} ${plural(count, "has", "have")} missing or conflicting routing, net pay, identity, duplicate, or group-review data.`,
      href: "/settlements?focus=check-issues",
      action: "Verify checks",
    });
  }

  const moneySignals = money ? [
    dec(money.agencyOwes).greaterThan(0) ? `${formatMoney(money.agencyOwes)} to pay` : null,
    dec(money.employeesOwe).greaterThan(0) ? `${formatMoney(money.employeesOwe)} to collect` : null,
    dec(money.reservesToSetAside).greaterThan(0) ? `${formatMoney(money.reservesToSetAside)} to set aside` : null,
    money.creditCount > 0 && dec(money.credits).greaterThan(0)
      ? `${formatMoney(money.credits)} in ${money.creditCount.toLocaleString()} ${plural(money.creditCount, "credit")}`
      : null,
  ].filter((value): value is string => value !== null) : [];
  if (money && moneySignals.length > 0) {
    const href = dec(money.agencyOwes).greaterThan(0)
      ? "/settlements?queue=payable"
      : dec(money.employeesOwe).greaterThan(0)
        ? "/settlements?queue=receivable"
        : dec(money.reservesToSetAside).greaterThan(0)
          ? "/settlements?queue=reserve"
          : "/settlements?queue=credit";
    items.push({
      key: "money-queues",
      category: "Money",
      title: "Current money work is open",
      detail: `${joinSignals(moneySignals)}.`,
      href,
      action: "Open money queues",
    });
  }

  const plansWithoutApproval = Math.max(
    0,
    summary.financial.strategies - summary.financial.approvedStrategies,
  );
  if (plansWithoutApproval > 0) {
    items.push({
      key: "financial-approvals",
      category: "Setup",
      title: "Approved monthly amounts are missing",
      detail: `${plansWithoutApproval.toLocaleString()} ${plural(plansWithoutApproval, "financial plan")} ${plural(plansWithoutApproval, "needs", "need")} an approved final amount.`,
      href: "/calculations",
      action: "Open financial setup",
    });
  }

  return items.slice(0, 6);
}
