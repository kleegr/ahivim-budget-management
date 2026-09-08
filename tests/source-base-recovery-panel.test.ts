import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import * as money from "@/lib/money";
import * as reviewActions from "@/lib/nav/review-actions";
import type { SourceBaseRecoveryReview } from "@/lib/sheets/base-recovery";

const compiled = transformSync(readFileSync("src/components/source-base-recovery-panel.tsx", "utf8"), {
  loader: "tsx", format: "cjs", jsx: "automatic", tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
}).code;
const nodeRequire = createRequire(import.meta.url);
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)((name: string) => {
  if (name === "next/link") return function TestLink({ href, children }: { href: string; children: React.ReactNode }) {
    return React.createElement("a", { href }, children);
  };
  if (name === "@/lib/money") return money;
  if (name === "@/lib/nav/review-actions") return reviewActions;
  return nodeRequire(name);
}, loaded, loaded.exports);

type Selection = { action: "accept"; transactionIds: string[] } | { action: "undo"; acceptanceAuditId: string };
type Attempt = { signature: string; operationKey: string };
type Candidate = SourceBaseRecoveryReview["candidates"][number];
const { default: Panel, sourceBaseRecoveryAttempt, selectedSourceBaseTotals, sourceBaseHistoryHref } = loaded.exports as {
  default: React.ComponentType<{ review: SourceBaseRecoveryReview }>;
  sourceBaseRecoveryAttempt: (old: Attempt | undefined, selection: Selection, hash: string, reason: string, newKey: () => string) => Attempt;
  selectedSourceBaseTotals: (rows: Candidate[], side: "previous" | "next") => { base: string; employeePayment: string; agencyAdditional: string };
  sourceBaseHistoryHref: (id: unknown, batchId: unknown) => string | null;
};
const id = "00000000-0000-4000-8000-000000000051";
function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return { transactionId: id, sourceFileId: "00000000-0000-4000-8000-000000000052",
    importRowId: "00000000-0000-4000-8000-000000000053", sourceRowNumber: 12,
    individual: "Synthetic Individual", employee: "Synthetic Employee",
    previous: { base: "1.0000", employeePayment: "1.0000", agencyAdditional: "0.0000", mismatch: true },
    next: { base: "0.1234", employeePayment: "0.1234", agencyAdditional: "0.8766", mismatch: false },
    eligible: true, reviewReason: null, paid: false, groupBudgetBasis: false, ...overrides };
}
function review(overrides: Partial<SourceBaseRecoveryReview> = {}): SourceBaseRecoveryReview {
  return { sourceHash: "a".repeat(64), candidates: [candidate()], history: [], reviewReason: null, ...overrides };
}

describe("Employee base correction review", () => {
  it("adds four-place money exactly for a large selected batch, preserving explicit zero", () => {
    const rows = Array.from({ length: 782 }, () => candidate());
    expect(selectedSourceBaseTotals(rows, "next")).toEqual({ base: "96.4988", employeePayment: "96.4988", agencyAdditional: "685.5012" });
    expect(selectedSourceBaseTotals(rows, "previous")).toEqual({ base: "782.0000", employeePayment: "782.0000", agencyAdditional: "0.0000" });
    expect(selectedSourceBaseTotals([], "next")).toEqual({ base: "0.0000", employeePayment: "0.0000", agencyAdditional: "0.0000" });
  });

  it("reuses uncertain-request keys across selection order but separates source, reason, target and action changes", () => {
    const keys = vi.fn().mockReturnValueOnce("first").mockReturnValue("next");
    const selection = { action: "accept" as const, transactionIds: ["b", "a"] };
    const first = sourceBaseRecoveryAttempt(undefined, selection, "source-a", " Exact source ", keys);
    expect(sourceBaseRecoveryAttempt(first, { ...selection, transactionIds: ["a", "b"] }, "source-a", "Exact source", keys)).toBe(first);
    expect(keys).toHaveBeenCalledTimes(1);
    for (const [nextSelection, hash, reason] of [
      [selection, "source-b", "Exact source"], [selection, "source-a", "Another reason"],
      [{ ...selection, transactionIds: ["a"] }, "source-a", "Exact source"],
      [{ action: "undo", acceptanceAuditId: "audit-a" }, "source-a", "Exact source"],
    ] as [Selection, string, string][]) {
      expect(sourceBaseRecoveryAttempt(first, nextSelection, hash, reason, keys).signature).not.toBe(first.signature);
    }
  });

  it("requires both audit IDs and gives Save and Undo distinct authoritative history URLs", () => {
    const reversalId = "00000000-0000-4000-8000-000000000056";
    expect(sourceBaseHistoryHref(id, id)).toBe(`/exceptions?kind=rate&sourceBaseReview=${id}#source-base-history-${id}`);
    expect(sourceBaseHistoryHref(id, reversalId)).toBe(`/exceptions?kind=rate&sourceBaseReview=${reversalId}#source-base-history-${id}`);
    expect(new URL(sourceBaseHistoryHref(id, id)!, "https://example.com").search)
      .not.toBe(new URL(sourceBaseHistoryHref(id, reversalId)!, "https://example.com").search);
    for (const invalid of [null, undefined, {}, "", `${id}#changed`, ` ${id}`, "https://example.com"]) {
      expect(sourceBaseHistoryHref(invalid, id)).toBeNull();
      expect(sourceBaseHistoryHref(id, invalid)).toBeNull();
    }
  });

  it("shows exact source and related amount previews without preselecting a correction", () => {
    const html = renderToStaticMarkup(React.createElement(Panel, { review: review() }));
    expect(html).toContain("exact 0.1234");
    expect(html).toContain("exact 0.8766");
    expect(html).toContain(reviewActions.transactionReviewHref(id));
    expect(html).toContain(reviewActions.importCorrectionsHref(candidate().sourceFileId!, candidate().importRowId));
    expect(html).not.toContain("checked=");
    expect(html).toMatch(/disabled=""[^>]*>Review 0 selected corrections/);
  });

  it("does not invent a source failure when an empty review needs no Sheet read", () => {
    const html = renderToStaticMarkup(React.createElement(Panel, { review: review({
      candidates: [], history: [], sourceHash: null, reviewReason: null,
    }) }));
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("The current source could not be verified");
    expect(html).not.toContain("Review reversal");
    expect(html).not.toContain("Save corrections");
  });

  it("keeps an explicit failure visible even when no rows could be loaded", () => {
    const html = renderToStaticMarkup(React.createElement(Panel, { review: review({
      candidates: [], history: [], sourceHash: null, reviewReason: "The source review could not be loaded.",
    }) }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("The source review could not be loaded.");
  });

  it("keeps Paid activity and source failures visible with correction controls disabled", () => {
    const paid = candidate({ paid: true, eligible: false, reviewReason: "Paid activity needs payment history review." });
    const html = renderToStaticMarkup(React.createElement(Panel, { review: review({ candidates: [paid], sourceHash: null }) }));
    expect(html).toContain("Paid activity needs payment history review.");
    expect(html).toContain("The current source could not be verified");
    expect(html).toMatch(/aria-label="Select correction[^>]*disabled=""/);
    expect(html).not.toContain("Save corrections</button>");
  });

  it("preserves missing source amounts as unknown and never creates a fabricated source URL or zero total", () => {
    const missing = candidate({ eligible: false, previous: null, next: null, sourceFileId: null, sourceRowNumber: null,
      reviewReason: "Original source evidence is unavailable." });
    const html = renderToStaticMarkup(React.createElement(Panel, { review: review({ candidates: [missing], sourceHash: null,
      reviewReason: "Current Sheet read failed." }) }));
    expect(html).toContain("Unknown");
    expect(html).toContain("Source record unavailable");
    expect(html).toContain("Current Sheet read failed.");
    expect(html).not.toContain("/imports/null/");
    expect(html).not.toContain("$0.00");
    expect(() => selectedSourceBaseTotals([missing], "next")).toThrow("Unknown amounts");
  });

  it("preserves saved/reversed history and disables a reversal with changed payment evidence", () => {
    const entry: SourceBaseRecoveryReview["history"][number] = {
      acceptanceAuditId: id, acceptedAt: "2026-09-08T00:00:00Z", reason: "Original and current source agree",
      transactionCount: 1, reversedAt: null, reversalAuditId: null,
      previousTotals: selectedSourceBaseTotals([candidate()], "previous"), nextTotals: selectedSourceBaseTotals([candidate()], "next"),
      groupBudgetBasisCount: 0, canUndo: false, undoReviewReason: "Paid activity now requires review.",
      items: [{ ...candidate(), previous: candidate().previous!, next: candidate().next! }],
    };
    const html = renderToStaticMarkup(React.createElement(Panel, { review: review({ candidates: [], history: [entry,
      { ...entry, acceptanceAuditId: "00000000-0000-4000-8000-000000000054", reversedAt: "2026-09-08T01:00:00Z", reversalAuditId: "00000000-0000-4000-8000-000000000055" }] }) }));
    expect(html).toContain(`id="source-base-history-${id}"`);
    expect(html).toContain("Paid activity now requires review.");
    expect(html).toContain("Saved amount changes");
    expect(html).toContain("exact 0.1234");
    expect(html).toContain("exact 0.8766");
    expect(html).toContain("Original source row 12");
    expect(html).toContain(reviewActions.transactionReviewHref(id));
    expect(html).toMatch(/disabled=""[^>]*>Review reversal/);
    expect(html.match(/>Review reversal<\/button>/g)).toHaveLength(1);
    expect(html).toContain("Reversed");
    const unavailable = renderToStaticMarkup(React.createElement(Panel, { review: review({
      candidates: [], history: [{ ...entry, canUndo: true, undoReviewReason: null }], sourceHash: null,
    }) }));
    expect(unavailable).toContain("The current source could not be verified");
    expect(unavailable).toMatch(/disabled=""[^>]*>Review reversal/);
  });
});
