import { describe, expect, it } from "vitest";
import { dashboardWorkstreamSummaries } from "@/lib/dashboard/workstreams";

const emptyInput = () => ({
  planning: {
    atLimit: 0,
    behindPace: 0,
    renewalSoon: 0,
    billingWithoutBudget: 0,
  },
  money: {
    ledgerNeedsRefresh: false,
    openItems: 0,
    partialPayments: 0,
    availableCredits: 0,
  },
  staffing: {
    missingDeals: 0,
    checkIssues: 0,
  },
  review: {
    unknownPrograms: 0,
    unmatchedNames: 0,
    duplicateIndividuals: 0,
    pendingAliases: 0,
    reconciliationDifferences: 0,
    rateExceptions: 0,
    duplicateCandidates: 0,
    groupReviewIssues: 0,
    overAuthorization: 0,
  },
});

describe("dashboardWorkstreamSummaries", () => {
  it("keeps responsibilities in a stable role-first order", () => {
    const summaries = dashboardWorkstreamSummaries(emptyInput());

    expect(summaries.map(({ key, role, href }) => ({ key, role, href }))).toEqual([
      { key: "planning", role: "Planner", href: "/schedule" },
      { key: "money", role: "Collector", href: "/collections" },
      { key: "staffing", role: "Staffing", href: "/employees" },
      { key: "review", role: "Administrator", href: "/review" },
    ]);
    expect(summaries.every((summary) => summary.tone === "good" && summary.openCount === 0)).toBe(true);
  });

  it("separates work that needs a decision from monitoring signals", () => {
    const input = emptyInput();
    input.review.unmatchedNames = 3;
    input.review.pendingAliases = 2;
    input.review.reconciliationDifferences = 1;
    input.review.rateExceptions = 7;
    input.review.groupReviewIssues = 4;
    input.review.overAuthorization = 2;

    const review = dashboardWorkstreamSummaries(input).find((summary) => summary.key === "review");

    expect(review).toMatchObject({ openCount: 6, monitoringCount: 13, tone: "warn" });
  });

  it("raises urgent configuration failures without mixing them into money work", () => {
    const input = emptyInput();
    input.planning.atLimit = 2;
    input.planning.billingWithoutBudget = 3;
    input.money.openItems = 7;
    input.money.partialPayments = 4;
    input.staffing.missingDeals = 5;
    input.staffing.checkIssues = 1;

    const summaries = Object.fromEntries(
      dashboardWorkstreamSummaries(input).map((summary) => [summary.key, summary]),
    );

    expect(summaries.planning).toMatchObject({ openCount: 5, tone: "danger" });
    expect(summaries.money).toMatchObject({ openCount: 11, tone: "warn" });
    expect(summaries.staffing).toMatchObject({ openCount: 6, tone: "danger" });
  });
});
