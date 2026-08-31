export type DashboardWorkstreamKey = "planning" | "money" | "staffing" | "review";
export type DashboardWorkstreamTone = "danger" | "warn" | "info" | "good";

export interface DashboardWorkstreamSummary {
  key: DashboardWorkstreamKey;
  label: string;
  role: string;
  href: string;
  openCount: number;
  monitoringCount: number;
  tone: DashboardWorkstreamTone;
}

export interface DashboardWorkstreamInput {
  planning: {
    atLimit: number;
    behindPace: number;
    renewalSoon: number;
    billingWithoutBudget: number;
  };
  money: {
    ledgerNeedsRefresh: boolean;
    openItems: number;
    partialPayments: number;
    availableCredits: number;
  };
  staffing: {
    missingDeals: number;
    checkIssues: number;
  };
  review: {
    unknownPrograms: number;
    unmatchedNames: number;
    duplicateIndividuals: number;
    pendingAliases: number;
    reconciliationDifferences: number;
    rateExceptions: number;
    duplicateCandidates: number;
    groupReviewIssues: number;
    overAuthorization: number;
  };
}

function count(values: number[]): number {
  return values.reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
}

/**
 * Keep the owner overview aligned with the responsibility-specific workspaces.
 * Review decisions intentionally exclude monitoring signals so the dashboard
 * and Review inbox describe the same amount of work waiting for a person.
 */
export function dashboardWorkstreamSummaries(input: DashboardWorkstreamInput): DashboardWorkstreamSummary[] {
  const planningOpen = count([
    input.planning.atLimit,
    input.planning.behindPace,
    input.planning.renewalSoon,
    input.planning.billingWithoutBudget,
  ]);
  const planningUrgent = count([input.planning.atLimit, input.planning.billingWithoutBudget]);

  const moneyOpen = count([
    input.money.ledgerNeedsRefresh ? 1 : 0,
    input.money.openItems,
    input.money.partialPayments,
    input.money.availableCredits,
  ]);
  const staffingOpen = count([input.staffing.missingDeals, input.staffing.checkIssues]);

  const reviewOpen = count([
    input.review.unknownPrograms,
    input.review.unmatchedNames,
    input.review.duplicateIndividuals,
    input.review.pendingAliases,
    input.review.reconciliationDifferences,
  ]);
  const reviewMonitoring = count([
    input.review.rateExceptions,
    input.review.duplicateCandidates,
    input.review.groupReviewIssues,
    input.review.overAuthorization,
  ]);

  return [
    {
      key: "planning",
      label: "Budget planning",
      role: "Planner",
      href: "/schedule",
      openCount: planningOpen,
      monitoringCount: 0,
      tone: planningUrgent > 0 ? "danger" : planningOpen > 0 ? "warn" : "good",
    },
    {
      key: "money",
      label: "Money operations",
      role: "Collector",
      href: "/masser",
      openCount: moneyOpen,
      monitoringCount: 0,
      tone: input.money.ledgerNeedsRefresh ? "danger" : moneyOpen > 0 ? "warn" : "good",
    },
    {
      key: "staffing",
      label: "Employee setup",
      role: "Staffing",
      href: "/employees",
      openCount: staffingOpen,
      monitoringCount: 0,
      tone: staffingOpen > 0 ? "danger" : "good",
    },
    {
      key: "review",
      label: "Data review",
      role: "Administrator",
      href: "/review",
      openCount: reviewOpen,
      monitoringCount: reviewMonitoring,
      tone: reviewOpen > 0 ? "warn" : reviewMonitoring > 0 ? "info" : "good",
    },
  ];
}
