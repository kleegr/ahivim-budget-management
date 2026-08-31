import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nav = readFileSync("src/components/app-nav.tsx", "utf8");
const layout = readFileSync("src/app/(app)/layout.tsx", "utf8");
const transactionPage = readFileSync("src/app/(app)/transactions/page.tsx", "utf8");
const transactionGrid = readFileSync("src/components/transactions/transactions-grid.tsx", "utf8");
const users = readFileSync("src/components/settings/user-access-admin.tsx", "utf8");

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

  it("opens the actual individual budget from transaction details", () => {
    expect(transactionGrid).toContain("individualBudgetHref(row.individualId)");
    expect(transactionGrid).not.toContain("/calculations?individualId=${row.individualId}");
    expect(transactionGrid).toContain('label: "Duplicate review"');
  });

  it("acknowledges a Sign In As click before the full portal reload", () => {
    expect(users).toContain("setImpersonatingId(u.id)");
    expect(users).toContain('impersonatingId === u.id ? "Opening..." : "Sign in as"');
  });
});
