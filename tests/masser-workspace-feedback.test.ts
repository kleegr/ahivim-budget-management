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

  it("makes the complete money workflow discoverable from Masser", () => {
    const source = readFileSync(resolve("src/app/(app)/masser/page.tsx"), "utf8");
    expect(source).toContain('title="Money to collect, pay, and put away"');
    expect(source).toContain('href="/settlements"');
    expect(source).toContain("agency payments, credits, corrections, reversals, and completed history");
  });

  it("shows employee deal links only when that account can view deals", () => {
    expect(workspaceSource).toContain(
      'canManageEmployeeDeals ? "View or change deal" : "View deal"',
    );
    expect(workspaceSource).toContain("canSeeEmployeeDeals ? <>");
    expect(workspaceSource).toContain("(manager changes)");
  });

  it("does not link source rows or show an empty action column without access", () => {
    expect(workspaceSource).toMatch(/canSeeTransactions \? \(\s*<Link href=\{payrollCheckRowsHref\(row\)\}/u);
    expect(workspaceSource).toContain("row.linkedTransactions > 0");
    expect(workspaceSource).toContain('{canManageChecks ? <th className="px-3 py-2.5 text-right">Action</th> : null}');
    expect(workspaceSource).toMatch(
      /\{canManageChecks \? \(\s*<td className="px-3 py-3 text-right">/u,
    );
    const dataSource = readFileSync(resolve("src/lib/data/direct-pay-operations.ts"), "utf8");
    expect(dataSource).toContain("scope.canSeeTransactions ? row.transaction_ids ?? [] : []");
  });

  it("links managers directly to the individual set-aside workflow", () => {
    expect(workspaceSource).toContain(
      "`/settlements?individualId=${row.individualId}&queue=reserve`",
    );
    expect(workspaceSource).toContain("Record set-aside");
  });

  it("does not offer a dead collection action to read-only viewers", () => {
    expect(workspaceSource).toContain(
      '{canManage ? <td className="px-3 py-3 text-right"><Link className="btn btn-sm btn-ghost whitespace-nowrap"',
    );
    expect(workspaceSource).toContain(
      '{canManage ? <th className="px-3 py-2.5 text-right">Action</th> : null}',
    );
  });

  it("gives Masser tabs, dismiss actions, and table links mobile touch targets", () => {
    expect(workspaceSource).toContain("touch-target flex shrink-0 items-center");
    expect(workspaceSource).toContain("touch-target inline-flex items-center px-2");
    expect(workspaceSource.match(/<table className="touch-table/g)).toHaveLength(3);
  });

  it("separates the approved monthly plan from recorded ledger facts", () => {
    expect(workspaceSource).toContain("Approved monthly set-aside");
    expect(workspaceSource).toContain("Recorded this month");
    expect(workspaceSource).toContain("Ledger remaining");
    expect(workspaceSource).toContain("data.summary.approvedMonthlySetAside");
    expect(workspaceSource).toContain("canManage && row.trackedPlans > 0");
  });

  it("discloses unavailable historical setup state instead of displaying a false zero", () => {
    const statementSource = readFileSync(
      resolve("src/app/(app)/masser/individuals/[id]/page.tsx"),
      "utf8",
    );
    expect(workspaceSource).toContain("!data.setupHistoryAvailable");
    expect(workspaceSource).toContain("approved monthly plan is unavailable");
    expect(statementSource).toContain("!statement.setupHistoryAvailable");
    expect(statementSource).toContain('"Unavailable"');
    expect(statementSource).toContain("Recorded over plan period");
  });

  it("makes a missing renewal actionable only for financial-plan managers", () => {
    const pageSource = readFileSync(resolve("src/app/(app)/masser/page.tsx"), "utf8");
    const statementSource = readFileSync(
      resolve("src/app/(app)/masser/individuals/[id]/page.tsx"),
      "utf8",
    );
    expect(workspaceSource).toContain("Renewal dates needed");
    expect(workspaceSource).toContain("canManageFinancialPlans ?");
    expect(workspaceSource).toContain('href={`/individuals/${row.individualId}?view=financial`}');
    expect(pageSource).toContain('scope.full && scope.canSeeBudgets');
    expect(statementSource).toContain("Employee and payroll details are excluded.");
    expect(statementSource).toContain("Ask an owner or manager to add the renewal date.");
  });

  it("uses a short check identity for transaction drilldowns", () => {
    expect(workspaceSource).toContain("payrollCheckRowsHref(row)");
    expect(workspaceSource).toContain('params.set("checkDateFrom", check.checkDate)');
    expect(workspaceSource).not.toContain('params.append("transactionId"');
  });
});
