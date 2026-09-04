import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assignmentIsCurrent,
  summarizeActiveFinancialSetups,
} from "@/lib/data/individual-profile";

const page = readFileSync("src/app/(app)/individuals/[id]/page.tsx", "utf8");

describe("Individual Profile current-state facts", () => {
  it("treats assignment date bounds as inclusive and excludes expired or future rows", () => {
    expect(assignmentIsCurrent({ startDate: null, endDate: null }, "2026-09-04")).toBe(true);
    expect(assignmentIsCurrent({ startDate: "2026-09-04", endDate: "2026-09-04" }, "2026-09-04")).toBe(true);
    expect(assignmentIsCurrent({ startDate: "2026-09-05", endDate: null }, "2026-09-04")).toBe(false);
    expect(assignmentIsCurrent({ startDate: null, endDate: "2026-09-03" }, "2026-09-04")).toBe(false);
    expect(page).toContain("assignmentIsCurrent(a, today)");
  });

  it("uses the authoritative current aggregate for multiple active financial setups", () => {
    const strategies = [
      { label: "Account 1", afterAll: "100.10" },
      { label: "Account 2", afterAll: "200.20" },
    ];

    expect(summarizeActiveFinancialSetups(strategies, "425.55")).toEqual({
      labels: ["Account 1", "Account 2"],
      approvedMonthly: "425.5500",
    });
    expect(summarizeActiveFinancialSetups(strategies)).toEqual({
      labels: ["Account 1", "Account 2"],
      approvedMonthly: "300.3000",
    });
    expect(summarizeActiveFinancialSetups([
      { label: "Awaiting approval", afterAll: null },
    ])).toEqual({ labels: ["Awaiting approval"], approvedMonthly: null });

    expect(page).toContain("masserStatement?.approvedMonthlyPlan");
    expect(page).toContain("financialSetupOverview.approvedMonthly");
    expect(page).toContain("total approved monthly");
    expect(page).not.toContain("approvedMonthlyPutAway={canSeeFinancialSetup ? strategy?.afterAll");
  });
});
