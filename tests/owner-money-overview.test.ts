import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getSettlementSummary } from "@/lib/data/settlements";
import type { PgLikePool } from "@/lib/import/commit";

describe("owner actual-money overview", () => {
  it("loads actual agency financials and current settlement balances separately from setup", () => {
    const page = readFileSync("src/app/(app)/dashboard/page.tsx", "utf8");
    const dashboard = readFileSync("src/components/dashboard/owner-dashboard.tsx", "utf8");

    expect(page).not.toContain("getAgencyFinancialReport(pool, financialMonth)");
    expect(page).not.toContain("getSettlementSummary(pool)");
    expect(page).toContain("financialMonth={financialMonth}");
    expect(dashboard).toContain("<Suspense fallback={<OwnerMoneyLoading");
    expect(dashboard).toContain("async function OwnerActualMoneySection");
    expect(dashboard).toContain("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(dashboard).toContain("getAgencyFinancialReport(client, month)");
    expect(dashboard).toContain("getSettlementSummary(client)");
    expect(dashboard).toContain('client.query("COMMIT")');
    expect(dashboard).toContain("The rest of the owner overview is still current.");
    expect(dashboard).toContain('eyebrow="Actual money"');
    expect(dashboard).toContain('title="Money"');
    expect(dashboard).toContain('eyebrow="Financial setup"');
    expect(dashboard).toContain("actualMoney.totals.income.total");
    expect(dashboard).toContain("actualMoney.operations.employeesOwe");
  });

  it("derives the owner balance band from active ledger balances", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          { direction: "payable", original_amount: "100", applied_amount: "25", status: "active" },
          { direction: "receivable", original_amount: "80", applied_amount: "0", status: "active" },
          { direction: "reserve", original_amount: "50", applied_amount: "10", status: "active" },
          { direction: "payable", original_amount: "30", applied_amount: "0", status: "void" },
        ],
      })),
    } as unknown as PgLikePool;

    const summary = await getSettlementSummary(pool);
    expect(summary).toEqual(expect.objectContaining({
      agencyOwes: "75.0000",
      employeesOwe: "80.0000",
      reservesToSetAside: "40.0000",
      openCount: 1,
      partialCount: 2,
      voidCount: 1,
    }));
  });
});
