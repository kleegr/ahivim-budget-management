import { describe, expect, it } from "vitest";
import {
  exceptionQueueHref,
  friendlyActionError,
  importCorrectionsHref,
  importIssueCopy,
  individualBudgetHref,
  individualPortfolioHref,
  normalizeIndividualAttentionView,
  reviewQueueHref,
  transactionReviewHref,
} from "@/lib/nav/review-actions";

describe("actionable review destinations", () => {
  it("carries the exact source row into the correction queue", () => {
    expect(importCorrectionsHref("file-1", "row-7")).toBe(
      "/imports/file-1/corrections?row=row-7#row-row-7",
    );
    expect(importCorrectionsHref("file-1")).toBe("/imports/file-1/corrections");
  });

  it("opens exact transactions and budget views", () => {
    expect(transactionReviewHref("transaction-1")).toBe("/transactions?transactionId=transaction-1");
    expect(individualBudgetHref("person-1")).toBe("/individuals/person-1?view=budget");
    expect(individualPortfolioHref("billing_without_budget")).toBe(
      "/individuals?view=billing_without_budget",
    );
  });

  it("routes every review queue to its relevant filtered destination", () => {
    expect(reviewQueueHref("sync_conflicts")).toBe("/sync#sync-conflicts");
    expect(reviewQueueHref("unmatched_names")).toBe(exceptionQueueHref("unmatched_name"));
    expect(reviewQueueHref("unknown_programs")).toBe("/exceptions?kind=unknown_program");
    expect(reviewQueueHref("duplicate_rows")).toBe("/exceptions?kind=possible_duplicate");
    expect(reviewQueueHref("rates")).toBe("/exceptions?kind=rate");
    expect(reviewQueueHref("groups")).toBe("/reconciliation/groups?status=needs_review");
    expect(reviewQueueHref("reconciliation")).toBe("/imports?view=reconciliation");
    expect(reviewQueueHref("over_authorization")).toBe("/individuals?view=over");
  });

  it("accepts only supported individual portfolio views", () => {
    expect(normalizeIndividualAttentionView("at_limit")).toBe("at_limit");
    expect(normalizeIndividualAttentionView("billing_without_budget")).toBe("billing_without_budget");
    expect(normalizeIndividualAttentionView("anything-else")).toBe("all");
  });
});

describe("plain-language issue copy", () => {
  it("explains known import issues as decisions", () => {
    expect(importIssueCopy("unknown_program", "raw detail")).toBe(
      "Choose the correct program for this row.",
    );
    expect(importIssueCopy("unmatched_employee", "raw detail")).toBe(
      "Choose the correct employee for this row.",
    );
    expect(importIssueCopy("possible_duplicate", "raw detail")).toContain("exact committed transaction");
  });

  it("keeps concise business errors but hides SQL and runtime diagnostics", () => {
    expect(friendlyActionError("Choose a valid program.", "Try again.")).toBe("Choose a valid program.");
    expect(
      friendlyActionError(
        'column "direct_sources.check_number" must appear in the GROUP BY clause',
        "The action could not be completed.",
      ),
    ).toBe("The action could not be completed.");
  });
});
