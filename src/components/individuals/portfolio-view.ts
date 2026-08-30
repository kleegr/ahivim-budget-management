import {
  individualPortfolioHref,
  normalizeIndividualAttentionView,
  type IndividualAttentionView,
} from "@/lib/nav/review-actions";

export type SimplePortfolioView = "all" | "with_budget" | "without_budget";
export type DetailedPortfolioView = Exclude<IndividualAttentionView, "all">;
export type PortfolioView = IndividualAttentionView | Exclude<SimplePortfolioView, "all">;

export const DEFAULT_HIDDEN_PORTFOLIO_COLUMNS = [
  "lastBilled",
  "programs",
  "status",
  "used",
  "weekly",
  "billedHours",
  "transactions",
  "billedAmount",
] as const;

const SIMPLE_VIEWS = new Set<PortfolioView>(["all", "with_budget", "without_budget"]);

export function resolvePortfolioView({
  view,
  budget,
}: {
  view?: string;
  budget?: string;
}): PortfolioView {
  const detailed = normalizeIndividualAttentionView(view);
  if (detailed !== "all" || view === "all") return detailed;
  if (budget === "with") return "with_budget";
  if (budget === "without") return "without_budget";
  return "all";
}

export function portfolioViewHref(view: PortfolioView): string {
  if (view === "with_budget") return "/individuals?budget=with";
  if (view === "without_budget") return "/individuals?budget=without";
  return individualPortfolioHref(view);
}

export function isDetailedPortfolioView(view: PortfolioView): view is DetailedPortfolioView {
  return !SIMPLE_VIEWS.has(view);
}

export function matchesSimplePortfolioView(
  row: { insightsVisible: boolean; budget: unknown | null },
  view: SimplePortfolioView,
): boolean {
  if (view === "with_budget") return row.insightsVisible && row.budget !== null;
  if (view === "without_budget") return row.insightsVisible && row.budget === null;
  return true;
}
