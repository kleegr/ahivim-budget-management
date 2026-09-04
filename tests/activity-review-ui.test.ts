import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Activity review entry", () => {
  it("keeps source disagreements in the decision-first inbox", () => {
    const reviewPage = readFileSync(resolve("src/app/(app)/review/page.tsx"), "utf8");
    const activityPage = readFileSync(resolve("src/app/(app)/transactions/page.tsx"), "utf8");

    expect(reviewPage).toContain("getActivityReviewSummary");
    expect(reviewPage).toContain('reviewQueueHref("sync_conflicts")');
    expect(reviewPage).toContain("d.changedSourceRecords + d.missingSourceRecords");
    expect(activityPage).toContain("reviewSummary={result.data.reviewSummary}");
    expect(activityPage).toContain('normalizedRequestedView ?? "rows"');
  });

  it("offers exact source evidence without making import machinery the normal view", () => {
    const grid = readFileSync(resolve("src/components/transactions/transactions-grid.tsx"), "utf8");

    expect(grid).toContain("Open exact source record");
    expect(grid).toContain("importCorrectionsHref(row.sourceFileId, row.importRowId)");
    expect(grid).toContain('label: "Original source"');
    expect(grid).toMatch(/label: "Original source"[^\n]+hidden: true[^\n]+r\.sourceName/);
    expect(grid).not.toContain("Import batch →");
  });
});
