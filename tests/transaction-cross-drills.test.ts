import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("transaction source drilldowns", () => {
  it("opens the import batch route with the batch id, not the uploaded file id", () => {
    const source = readFileSync("src/components/transactions/transactions-grid.tsx", "utf8");

    expect(source).toContain('row.importBatchId && <Link href={`/imports/${row.importBatchId}`}');
    expect(source).not.toContain('href={`/imports/${row.sourceFileId}`}');
  });

  it("opens a linked imported group session on its exact group-review record", () => {
    const source = readFileSync("src/components/transactions/transactions-grid.tsx", "utf8");

    expect(source).toContain('["detected", "needs_review", "confirmed"].includes(row.groupDetectionStatus ?? "")');
    expect(source).toContain("/reconciliation/groups?sessionId=${row.serviceSessionId}");
    expect(source).not.toContain('row.serviceSessionId && <Link href={`/reconciliation`}');
  });

  it("does not send an ordinary single-row service session to group review", () => {
    const readModel = readFileSync("src/lib/data/transactions-grid.ts", "utf8");

    expect(readModel).toContain("ss.group_detection_status");
    expect(readModel).toContain("groupDetectionStatus: r.group_detection_status");
  });
});
