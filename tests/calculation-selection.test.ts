import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  selectedFinancialSetups,
  summarizeFinancialSetups,
  type FinancialSetupSummaryRow,
} from "@/components/calculations/financial-setup-summary";

const rows: FinancialSetupSummaryRow[] = [
  {
    id: "setup-a",
    individualId: "person-a",
    status: "active",
    yearlyGross: "1000.10",
    monthlyGross: "83.3417",
    net: "60.12",
    afterAll: "55.55",
  },
  {
    id: "setup-b",
    individualId: "person-a",
    status: "active",
    yearlyGross: "2000.20",
    monthlyGross: "166.6833",
    net: "120.24",
    afterAll: null,
  },
  {
    id: "setup-c",
    individualId: "person-b",
    status: "active",
    yearlyGross: "3000.30",
    monthlyGross: "250.025",
    net: "180.36",
    afterAll: "144.45",
  },
  {
    id: "archived-setup",
    individualId: "person-c",
    status: "archived",
    yearlyGross: "999999",
    monthlyGross: "999999",
    net: "999999",
    afterAll: "999999",
  },
];

describe("Financial Setup selected totals", () => {
  it("wires selection and the full cut chain into the working grid", () => {
    const grid = readFileSync("src/components/calculations/calculations-grid.tsx", "utf8");

    expect(grid).toContain("Select all current matching financial setups");
    expect(grid).toContain("combined Approved Final");
    for (const column of [
      'key: "cut1Amount", label: "First cut amount"',
      'key: "afterCut1", label: "After first cut"',
      'key: "cut2Amount", label: "Second cut amount"',
      'key: "approvedDifference", label: "Approved − calculated"',
    ]) {
      expect(grid).toContain(column);
    }
  });

  it("combines only selected current rows with decimal-safe approved totals", () => {
    const selected = selectedFinancialSetups(rows, new Set(["setup-a", "setup-c", "archived-setup"]));

    expect(selected.map((row) => row.id)).toEqual(["setup-a", "setup-c"]);
    expect(summarizeFinancialSetups(selected)).toEqual({
      yearly: "4000.40",
      monthly: "333.37",
      calculated: "240.48",
      approved: "200.00",
      approvedCount: 2,
      activeCount: 2,
      individualCount: 2,
    });
  });

  it("keeps a missing approval distinct from an approved zero", () => {
    const total = summarizeFinancialSetups([
      { ...rows[0]!, id: "zero", afterAll: "0" },
      { ...rows[1]!, id: "missing", afterAll: null },
    ]);

    expect(total.approved).toBe("0.00");
    expect(total.approvedCount).toBe(1);
  });

  it("does not let archived history re-enter current totals", () => {
    expect(summarizeFinancialSetups(rows)).toMatchObject({
      yearly: "6000.60",
      approved: "200.00",
      activeCount: 3,
      individualCount: 2,
    });
  });
});
