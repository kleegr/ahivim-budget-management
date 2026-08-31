import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceSource = readFileSync(
  resolve("src/components/collections/collections-workspace.tsx"),
  "utf8",
);

describe("Masser request feedback", () => {
  it("shows the API error instead of replacing it with a generic message", async () => {
    expect(workspaceSource).toContain(
      "payload.error ?? payload.message ?? \"The request could not be completed.\"",
    );
  });

  it("keeps settlement refresh warnings visually distinct from successful saves", () => {
    expect(workspaceSource).toContain('{ tone: "warning", message: payload.settlementWarning }');
    expect(workspaceSource).toContain('<Notice tone={notice.tone}');
    expect(workspaceSource).not.toContain('notice.toLowerCase().includes("could not")');
  });

  it("keeps the Masser server render read-only", () => {
    const source = readFileSync(resolve("src/app/(app)/masser/page.tsx"), "utf8");
    expect(source).not.toContain("syncImportedPayrollCheckReviews");
  });

  it("does not imply a viewer collector can change employee deals", () => {
    expect(workspaceSource).toContain(
      'canManageEmployeeDeals ? "View or change deal" : "View deal"',
    );
    expect(workspaceSource).toContain("(manager changes)");
  });

  it("links managers directly to the individual set-aside workflow", () => {
    expect(workspaceSource).toContain(
      "`/settlements?individualId=${row.individualId}&queue=reserve`",
    );
    expect(workspaceSource).toContain("Record set-aside");
  });

  it("uses a short check identity for transaction drilldowns", () => {
    expect(workspaceSource).toContain("payrollCheckRowsHref(row)");
    expect(workspaceSource).toContain('params.set("checkDateFrom", check.checkDate)');
    expect(workspaceSource).not.toContain('params.append("transactionId"');
  });
});
