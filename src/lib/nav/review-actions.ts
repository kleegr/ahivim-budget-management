import { txLink } from "@/lib/nav/tx-link";

/**
 * Canonical destinations for review and exception actions.
 *
 * Review surfaces should never make each caller rebuild query strings. Keeping
 * the routes here also makes it explicit which screen can actually resolve an
 * issue, rather than sending every warning to a broad index page.
 */

export type IndividualAttentionView =
  | "all"
  | "attention"
  | "over"
  | "at_limit"
  | "behind"
  | "renewing"
  | "billing_without_budget"
  | "no_activity";

const INDIVIDUAL_VIEWS = new Set<IndividualAttentionView>([
  "all",
  "attention",
  "over",
  "at_limit",
  "behind",
  "renewing",
  "billing_without_budget",
  "no_activity",
]);

export function normalizeIndividualAttentionView(value: string | undefined): IndividualAttentionView {
  return value && INDIVIDUAL_VIEWS.has(value as IndividualAttentionView)
    ? (value as IndividualAttentionView)
    : "all";
}

export function individualPortfolioHref(view: IndividualAttentionView): string {
  return view === "all" ? "/individuals" : `/individuals?view=${view}`;
}

export function individualBudgetHref(individualId: string): string {
  return `/individuals/${encodeURIComponent(individualId)}?view=budget`;
}

export function importCorrectionsHref(fileId: string, rowId?: string | null): string {
  const base = `/imports/${encodeURIComponent(fileId)}/corrections`;
  if (!rowId) return base;
  const encoded = encodeURIComponent(rowId);
  return `${base}?row=${encoded}#row-${encoded}`;
}

export function transactionReviewHref(transactionId: string): string {
  return txLink({ transactionId });
}

export type ExceptionQueue = "all" | "rate" | "unknown_program" | "unmatched_name" | "possible_duplicate";

export function exceptionQueueHref(queue: ExceptionQueue): string {
  return queue === "all" ? "/exceptions" : `/exceptions?kind=${queue}`;
}

export type ReviewQueue =
  | "unmatched_names"
  | "pending_aliases"
  | "duplicate_people"
  | "unknown_programs"
  | "reconciliation"
  | "rates"
  | "groups"
  | "duplicate_rows"
  | "over_authorization";

const REVIEW_QUEUE_HREFS: Record<ReviewQueue, string> = {
  unmatched_names: exceptionQueueHref("unmatched_name"),
  pending_aliases: "/aliases?status=pending",
  duplicate_people: "/matches",
  unknown_programs: exceptionQueueHref("unknown_program"),
  reconciliation: "/imports?view=reconciliation",
  rates: exceptionQueueHref("rate"),
  groups: "/reconciliation/groups?status=needs_review",
  duplicate_rows: exceptionQueueHref("possible_duplicate"),
  over_authorization: individualPortfolioHref("over"),
};

export function reviewQueueHref(queue: ReviewQueue): string {
  return REVIEW_QUEUE_HREFS[queue];
}

const IMPORT_ISSUE_COPY: Record<string, string> = {
  unknown_program: "Choose the correct program for this row.",
  unmatched_individual: "Choose the correct individual for this row.",
  unmatched_employee: "Choose the correct employee for this row.",
  ambiguous_name: "Choose which person this imported name belongs to.",
  possible_duplicate: "Inspect the exact committed transaction and its import history before deciding whether follow-up is needed.",
  rate_exception: "Review the imported rate against the configured rate.",
  group_needs_review: "Confirm whether these rows belong to one group session.",
};

export function importIssueCopy(category: string, fallback?: string | null): string {
  return IMPORT_ISSUE_COPY[category]
    ?? friendlyActionError(fallback, "Review this imported row.");
}

const TECHNICAL_ERROR = /(?:\b(?:select|insert|update|delete)\b[\s\S]*\bfrom\b|\bcolumn\b[\s\S]*\bgroup by\b|\brelation\b[\s\S]*\bdoes not exist\b|\b(?:econn|etimedout|sqlstate|postgres|constraint|syntax error)\b|\n\s*at\s)/i;

/** Keep useful business validation, but never show SQL/runtime diagnostics. */
export function friendlyActionError(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const value = raw
    .replace(/^error:\s*/i, "")
    .replace(/^sync failed:\s*/i, "")
    .trim();
  if (!value || value.length > 220 || TECHNICAL_ERROR.test(value)) return fallback;
  return value;
}
