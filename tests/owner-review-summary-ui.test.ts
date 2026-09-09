import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatKnownMoneyTotal } from "@/lib/business/transaction-totals";

const mocks = {
  getSettlementDashboard: vi.fn(),
  getOwnerScheduleAttention: vi.fn(),
  getOperationalReviewSummary: vi.fn(),
};
const client = { query: vi.fn(), release: vi.fn() };
const pool = { connect: vi.fn(async () => client) };
const compiled = transformSync(readFileSync("src/components/dashboard/owner-dashboard.tsx", "utf8"), {
  loader: "tsx", format: "cjs", jsx: "automatic", tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
}).code;
const nodeRequire = createRequire(import.meta.url);
const loaded = { exports: {} };
function EmptyComponent() { return null; }
function Anchor({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return React.createElement("a", { href, ...props }, children);
}
new Function("require", "module", "exports", compiled)((name: string) => {
  if (name === "next/link") return Anchor;
  if (name === "@/lib/data/pool") return {
    withDb: async (read: (connection: typeof pool) => Promise<unknown>) => {
      try { return { ok: true, data: await read(pool) }; }
      catch { return { ok: false, error: "Synthetic unavailable source" }; }
    },
  };
  if (name === "@/lib/data/settlements") return { getSettlementDashboard: mocks.getSettlementDashboard };
  if (name === "@/lib/dashboard/owner-schedule-attention") return { getOwnerScheduleAttention: mocks.getOwnerScheduleAttention };
  if (name === "@/lib/data/operational-review") return { getOperationalReviewSummary: mocks.getOperationalReviewSummary };
  if (name === "@/lib/data/agency-financial-report" || name === "@/lib/dashboard/owner-summary") return {};
  if (name === "@/lib/money") return { formatHours: String, formatMoney: String };
  if (name === "@/lib/business/transaction-totals") return { formatKnownMoneyTotal };
  if (name === "@/components/ui") return { ButtonLink: Anchor, PageHeader: EmptyComponent };
  if (name.startsWith("@/components/")) return EmptyComponent;
  return nodeRequire(name);
}, loaded, loaded.exports);
const OwnerReviewData = (loaded.exports as {
  OwnerReviewData: (props: { today: string }) => Promise<React.ReactNode>;
}).OwnerReviewData;

async function markup() {
  return renderToStaticMarkup(await OwnerReviewData({ today: "2026-09-09" }));
}

describe("Home grouped review summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.query.mockResolvedValue({ rows: [] });
    mocks.getOperationalReviewSummary.mockResolvedValue({
      individuals: 2, employees: 1, undecidedIndividuals: 3, undecidedEmployees: 4,
    });
    mocks.getOwnerScheduleAttention.mockResolvedValue({ conflictCount: 8, unassignedCount: 5 });
    mocks.getSettlementDashboard.mockResolvedValue({
      rows: [], checkIssues: Array.from({ length: 688 }, () => ({ transactionCount: 1200 })),
      freshness: { dirty: false, sourceReviewCount: 0 },
    });
  });

  it("groups review by people and workspace without presenting source rows as tasks", async () => {
    const html = await markup();
    expect(html).toContain("Review summary");
    expect(html).toContain("2 individuals with detected issues");
    expect(html).toContain("1 employee with detected issues");
    expect(html).toContain('href="/individuals?review=needs_review"');
    expect(html).toContain('href="/employees?review=needs_review"');
    expect(html).toContain('href="/schedule?view=coverage"');
    expect(html).toContain('href="/settlements?focus=check-issues"');
    expect(html).toContain("Upcoming visits have conflicts or need staffing.");
    expect(html).toContain("Check source information needs review before money actions.");
    expect(html).not.toMatch(/688|1,200|1200|Billing without budget|tasks|Needs attention/);
  });

  it("keeps undecided responsibility separate from detected issues", async () => {
    mocks.getOperationalReviewSummary.mockResolvedValue({
      individuals: 0, employees: 0, undecidedIndividuals: 3, undecidedEmployees: 1,
    });
    const html = await markup();
    expect(html).toContain("0 individuals with detected issues");
    expect(html).toContain("0 employees with detected issues");
    expect(html).toContain("Not decided yet: 3 individuals");
    expect(html).toContain("Not decided yet: 1 employee");
    expect(html).toContain('href="/individuals?management=undecided"');
    expect(html).toContain('href="/employees?management=undecided"');
    expect(html).not.toContain('role="alert"');
  });

  it("shows a retryable incomplete summary when a source fails, without inventing zero reviews", async () => {
    mocks.getOperationalReviewSummary.mockRejectedValue(new Error("Synthetic review failure"));
    const html = await markup();
    expect(html).toContain('role="alert"');
    expect(html).toContain("People and employee review status could not be loaded.");
    expect(html).toContain("The review summary is incomplete.");
    expect(html).toContain("Try again");
    expect(html).toContain("Review status unavailable");
    expect(html).not.toMatch(/0 individuals|0 employees|No follow-up|still current|Not decided yet/);
    expect(html).toContain("Upcoming visits have conflicts or need staffing.");
  });

  it("keeps stale balances unavailable without exposing historical balances as current obligations", async () => {
    mocks.getSettlementDashboard.mockResolvedValue({
      rows: [{ balance: "44400.00", reviewRequired: true }], checkIssues: [],
      summary: { employeesOwe: "44400.00", reservesToSetAside: "394690.38" },
      freshness: { dirty: true, sourceReviewCount: 80 },
    });
    const html = await markup();
    expect(html).toContain("Current balances are unavailable until refreshed.");
    expect(html).toContain('href="/masser"');
    expect(html).not.toMatch(/44,400|44400|394690|80 balances|80 tasks/);
  });

  it("continues to disclose historical holds after current balances have refreshed", async () => {
    mocks.getSettlementDashboard.mockResolvedValue({
      rows: [{ reviewRequired: true }], checkIssues: [], freshness: { dirty: false },
    });
    expect(await markup()).toContain("Some balances are held for review.");
  });
});
