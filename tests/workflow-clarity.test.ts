import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const nav = readFileSync("src/components/app-nav.tsx", "utf8");
const layout = readFileSync("src/app/(app)/layout.tsx", "utf8");
const transactionPage = readFileSync("src/app/(app)/transactions/page.tsx", "utf8");
const transactionGrid = readFileSync("src/components/transactions/transactions-grid.tsx", "utf8");
const masserPage = readFileSync("src/app/(app)/masser/page.tsx", "utf8");
const settlementDashboard = readFileSync("src/components/settlements/settlement-dashboard.tsx", "utf8");
const users = readFileSync("src/components/settings/user-access-admin.tsx", "utf8");
const ui = readFileSync("src/components/ui.tsx", "utf8");

function componentFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? componentFiles(path)
      : path.endsWith(".tsx")
        ? [path]
        : [];
  });
}

describe("primary workflow clarity", () => {
  it("shows route feedback for native form navigation without hijacking client forms", () => {
    expect(nav).toContain('document.addEventListener("submit", trackInternalForm)');
    expect(nav).toContain("if (event.defaultPrevented) return");
    expect(nav).toContain("top-[var(--impersonation-bar-height)]");
  });

  it("keeps sticky settings controls below the mobile app header", () => {
    expect(layout).toContain("[--shell-header-height:calc(var(--impersonation-bar-height)+4rem)]");
    expect(layout).toContain("md:[--shell-header-height:var(--impersonation-bar-height)]");
  });

  it("takes an empty transaction ledger to the Sheet refresh workflow", () => {
    expect(transactionPage).toContain('<ButtonLink href="/sync" variant="primary">');
    expect(transactionPage).toContain("Open Google Sheet sync");
  });

  it("opens Money-operation source rows through a compact server-scoped key", () => {
    expect(transactionPage).toContain("listSettlementSourceTransactions");
    expect(transactionPage).toContain("source transaction");
    expect(transactionPage).toContain('href="/settlements?focus=check-issues"');
    expect(masserPage).toContain("resolveSettlementSourceTransactions");
    expect(masserPage).toContain("Source rows are no longer available");
  });

  it("keeps large payroll-review queues searchable and incrementally rendered", () => {
    expect(settlementDashboard).toContain("const CHECK_ISSUE_PAGE_SIZE = 25");
    expect(settlementDashboard).toContain("Find a payroll source");
    expect(settlementDashboard).toContain("const visibleIssueStart = currentIssuePage * CHECK_ISSUE_PAGE_SIZE");
    expect(settlementDashboard).toContain("filteredIssues.slice(visibleIssueStart, visibleIssueStart + CHECK_ISSUE_PAGE_SIZE)");
    expect(settlementDashboard).toContain("Page {currentIssuePage + 1} of {issuePageCount}");
    expect(settlementDashboard).not.toContain("{data.checkIssues.map((issue) => {");
  });

  it("opens the actual individual budget from transaction details", () => {
    expect(transactionGrid).toContain("individualBudgetHref(row.individualId)");
    expect(transactionGrid).not.toContain("/calculations?individualId=${row.individualId}");
    expect(transactionGrid).toContain('label: "Review state"');
  });

  it("does not let the all-time period control erase a deep-linked check date", () => {
    expect(transactionGrid).toContain("hasInitialTransactionDateContext(initialFilters)");
    expect(transactionGrid).toContain("hasFixedDateContext ? null : <PeriodControl");
  });

  it("keeps paid actions busy until refreshed transaction data is committed", () => {
    expect(transactionGrid).toContain("const actionBusy = busy || refreshing");
    expect(transactionGrid).toContain("startRefresh(() => router.refresh())");
    expect(transactionGrid).toContain("const rowUpdating = actionBusy && busyIds.has(r.id)");
    expect(transactionGrid).toContain('{rowUpdating ? "Updating…"');
    expect(transactionGrid).toContain("const selectionUpdating = actionBusy");
  });

  it("acknowledges a Sign In As click before the full portal reload", () => {
    expect(users).toContain("setImpersonatingId(u.id)");
    expect(users).toContain('impersonatingId === u.id ? "Opening..." : "Sign in as"');
  });

  it("gives every server-rendered load error an immediate recovery action", () => {
    expect(ui).toContain("action={action ?? <ReloadButton />}");
    expect(ui).toContain('friendlyActionError(children, "This page could not load. Try again.")');
  });

  it("keeps feedback and a visible failure path in every component that writes through fetch", () => {
    const writers = componentFiles("src/components")
      .map((path) => ({ path, source: readFileSync(path, "utf8") }))
      .filter(({ source }) => source.includes("fetch("));

    expect(writers.length).toBeGreaterThan(20);
    for (const writer of writers) {
      expect(writer.source, `${writer.path} needs first-click feedback`).toMatch(
        /aria-busy|disabled=\{|busy|pending|loading|saving|submitting|isRunning|isSyncing/i,
      );
      expect(writer.source, `${writer.path} needs a visible failure path`).toMatch(
        /setError|role="alert"|friendlyActionError|\berror\b/i,
      );
    }
  });
});
