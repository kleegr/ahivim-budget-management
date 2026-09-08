import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnDef } from "@/components/data-grid/types";
import { exportRows } from "@/components/data-grid/engine";
import { summarizeSettlementRows, type SettlementDashboardData, type SettlementRow } from "@/lib/data/settlements";
import SettlementDashboard from "@/components/settlements/settlement-dashboard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const captured = vi.hoisted(() => ({ columns: [] as ColumnDef<SettlementRow>[] }));
vi.mock("@/components/data-grid/toolbar", () => ({ Toolbar: ({ grid }: { grid: { columns: ColumnDef<SettlementRow>[] } }) => {
  captured.columns = grid.columns;
  return null;
} }));

function row(overrides: Partial<SettlementRow> = {}): SettlementRow {
  return {
    id: "held-reserve", kind: "individual_masser", label: "Approved final reserve",
    direction: "reserve", directionLabel: "Set aside", personType: "individual",
    personId: "person-1", personName: "Example Person", originalAmount: "100.0000",
    appliedAmount: "20.0000", balance: "80.0000", state: "partial", checkNumber: null,
    checkDate: null, periodBegin: "2026-01-01", periodEnd: "2027-01-01",
    transactionCount: 0, eventCount: 1, lastActionAt: "2026-09-01", calculation: {},
    voidReason: null, createdAt: "2026-01-01", reviewRequired: true, ...overrides,
  };
}

function render(rows: SettlementRow[], options: { canSeeEmployeeDeals?: boolean; canManageFinancialPlans?: boolean; canManage?: boolean; dirty?: boolean } = {}) {
  const data: SettlementDashboardData = {
    rows, events: [], summary: summarizeSettlementRows(rows), missingDeals: [], checkIssues: [],
    freshness: { dirty: options.dirty ?? false, sourceVersion: "1", refreshedVersion: "1",
      dirtySince: null, lastRefreshedAt: "2026-09-08", refreshedForDate: "2026-09-08", lastRefreshError: null },
  };
  return renderToStaticMarkup(createElement(SettlementDashboard, {
    data, canManage: options.canManage ?? true, canManagePayrollChecks: false,
    canSeeEmployeeDeals: options.canSeeEmployeeDeals ?? false, canSeeTransactions: false,
    canManageFinancialPlans: options.canManageFinancialPlans,
    initialPersonId: "person-1", initialPersonType: "individual",
  }));
}

function metric(html: string, label: string): string {
  const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((part) => part.includes(`${label}</p>`));
  expect(button, `summary ${label} missing`).toBeDefined();
  return button!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("settlement balances on source review", () => {
  beforeEach(() => { captured.columns = []; });

  it("shows all-held balances as unavailable while retaining original and applied amounts in rows and exports", () => {
    const held = row();
    const html = render([held]);
    expect(metric(html, "Set aside")).toContain("Unavailable");
    expect(metric(html, "Set aside")).not.toContain("$0.00");
    expect(metric(html, "Open work")).toContain("Unavailable");
    expect(html).toContain("$100.00");
    expect(html).toContain("$20.00");
    expect(html).not.toContain("$80.00");
    expect(html).not.toContain(">Record amount</button>");
    const columns = captured.columns;
    expect(exportRows(columns, [held])[0]).toMatchObject({ original: "100.0000", applied: "20.0000", balance: null });
    expect(held.balance).toBe("80.0000");
  });

  it("keeps mixed verified amounts usable with explicit exclusions and does not freeze unrelated directions", () => {
    const html = render([
      row(),
      row({ id: "verified-reserve", reviewRequired: false, balance: "40.0000" }),
      row({ id: "verified-payment", direction: "payable", reviewRequired: false, balance: "30.0000" }),
    ]);
    expect(metric(html, "Set aside")).toContain("$40.00");
    expect(metric(html, "Set aside")).toContain("Verified subtotal · 1 held item excluded");
    expect(metric(html, "Agency pays")).toContain("$30.00");
    expect(metric(html, "Agency pays")).not.toMatch(/Unavailable|subtotal/);
    expect(html).toContain(">Record amount</button>");
  });

  it("distinguishes verified zero from a zero subtotal with held items", () => {
    const settled = row({ id: "settled", reviewRequired: false, balance: "0.0000", state: "settled", appliedAmount: "100.0000" });
    const verified = render([settled]);
    expect(metric(verified, "Set aside")).toContain("$0.00");
    expect(metric(verified, "Set aside")).not.toMatch(/Unavailable|subtotal/);
    const mixed = render([settled, row()]);
    expect(metric(mixed, "Set aside")).toContain("$0.00");
    expect(metric(mixed, "Set aside")).toContain("Verified subtotal");
    const columns = captured.columns;
    expect(exportRows(columns, [settled])[0]!.balance).toBe("0.0000");
  });

  it("excludes held credits from ready-to-apply counts and labels mixed credit totals", () => {
    const html = render([
      row({ id: "held-credit", state: "credit", balance: "-10.0000" }),
      row({ id: "verified-credit", state: "credit", reviewRequired: false, balance: "-25.0000" }),
      row({ id: "verified-target", reviewRequired: false, balance: "50.0000" }),
    ]);
    expect(metric(html, "Credits")).toContain("$25.00");
    expect(metric(html, "Credits")).toContain("Verified subtotal");
    expect(metric(html, "Open work")).toMatch(/\b2\b/);
  });

  it("does not let a held target make a verified credit ready to apply", () => {
    const html = render([row(), row({ id: "credit", reviewRequired: false, state: "credit", balance: "-25.0000" })]);
    expect(metric(html, "Open work")).toMatch(/\b0\b/);
  });

  it("keeps stale summary amounts unavailable until refresh", () => {
    const html = render([row({ reviewRequired: false })], { dirty: true });
    expect(metric(html, "Set aside")).toContain("Unavailable");
    expect(metric(html, "Set aside")).toContain("Refresh needed");
  });

  it("does not infer Financial Setup permission from collection access", () => {
    const html = render([row()]);
    expect(html).toContain("Ask an administrator to review");
    expect(html).toContain("Financial Setup");
    expect(html).not.toContain("?view=financial");
  });

  it("links the exact individual Financial Setup only with financial-plan permission", () => {
    const html = render([row()], { canManageFinancialPlans: true });
    expect(html).toContain('href="/individuals/person-1?view=financial"');
    expect(html).toContain("Review Financial Setup");
    expect(html).not.toContain("Ask an administrator to review");
  });

  it.each([false, true])("only links the exact employee deal when deal access is %s", (canSeeEmployeeDeals) => {
    const employee = row({ personType: "employee", personId: "employee-7", personName: "Example Employee" });
    const data: SettlementDashboardData = {
      rows: [employee], events: [], summary: summarizeSettlementRows([employee]), missingDeals: [], checkIssues: [],
      freshness: { dirty: false, sourceVersion: "1", refreshedVersion: "1", dirtySince: null,
        lastRefreshedAt: "2026-09-08", refreshedForDate: "2026-09-08", lastRefreshError: null },
    };
    const html = renderToStaticMarkup(createElement(SettlementDashboard, {
      data, canManage: false, canManagePayrollChecks: false, canSeeEmployeeDeals, canSeeTransactions: false,
    }));
    if (canSeeEmployeeDeals) expect(html).toContain('href="/employees/employee-7?view=deal"');
    else {
      expect(html).not.toContain("?view=deal");
      expect(html).toContain("Ask an administrator to review");
    }
  });
});
