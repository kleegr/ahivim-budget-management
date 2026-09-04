import { describe, expect, it } from "vitest";
import {
  DEFAULT_HIDDEN_PORTFOLIO_COLUMNS,
  isDetailedPortfolioView,
  matchesSimplePortfolioView,
  portfolioViewHref,
  resolvePortfolioView,
} from "@/components/individuals/portfolio-view";

describe("individual portfolio views", () => {
  it("shows the complete working scan and keeps only secondary details hidden", () => {
    expect(DEFAULT_HIDDEN_PORTFOLIO_COLUMNS).toEqual(expect.arrayContaining([
      "lastBilled",
      "monthly",
      "used",
      "transactions",
      "billedAmount",
    ]));
    for (const workingColumn of ["status", "programs", "authorized", "billedHours", "nextAction"]) {
      expect(DEFAULT_HIDDEN_PORTFOLIO_COLUMNS).not.toContain(workingColumn);
    }
  });

  it("uses calm budget setup filters with stable URLs", () => {
    expect(resolvePortfolioView({})).toBe("all");
    expect(resolvePortfolioView({ budget: "with" })).toBe("with_budget");
    expect(resolvePortfolioView({ budget: "without" })).toBe("without_budget");
    expect(portfolioViewHref("with_budget")).toBe("/individuals?budget=with");
    expect(portfolioViewHref("without_budget")).toBe("/individuals?budget=without");
  });

  it("preserves specialist deep links and opens them as detailed views", () => {
    expect(resolvePortfolioView({ view: "billing_without_budget", budget: "with" })).toBe("billing_without_budget");
    expect(portfolioViewHref("billing_without_budget")).toBe("/individuals?view=billing_without_budget");
    expect(isDetailedPortfolioView("billing_without_budget")).toBe(true);
    expect(isDetailedPortfolioView("without_budget")).toBe(false);
  });

  it("does not present redacted budget data as a missing budget", () => {
    expect(matchesSimplePortfolioView({ insightsVisible: true, budget: { id: "budget-1" } }, "with_budget")).toBe(true);
    expect(matchesSimplePortfolioView({ insightsVisible: true, budget: null }, "without_budget")).toBe(true);
    expect(matchesSimplePortfolioView({ insightsVisible: false, budget: null }, "without_budget")).toBe(false);
  });
});
