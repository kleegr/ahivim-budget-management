import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerDashboardSummary } from "@/lib/dashboard/owner-summary";
const mocks = vi.hoisted(() => ({ transactions: vi.fn(), budgets: vi.fn(), board: vi.fn(), strategies: vi.fn(), views: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => ({ id: "owner", role: "admin" }) }));
vi.mock("@/lib/data/pool", () => ({ withDb: async (run: (pool: object) => Promise<unknown>) => ({ ok: true, data: await run({}) }) }));
vi.mock("@/lib/data/transactions-grid", () => ({ listTransactionsForGrid: mocks.transactions }));
vi.mock("@/lib/data/program-budgets", () => ({ listCurrentProgramBudgets: mocks.budgets }));
vi.mock("@/lib/data/queries", () => ({ listIndividualBudgetBoard: mocks.board }));
vi.mock("@/lib/manage/calculation-strategies", () => ({ listStrategies: mocks.strategies }));
vi.mock("@/lib/manage/grid-views", () => ({ listGridViews: mocks.views }));
vi.mock("@/components/dashboard/owner-dashboard", () => ({ default: () => null }));
vi.mock("@/components/sync/google-sheet-sync-button", () => ({ default: () => null }));
vi.mock("@/lib/data/agency-financial-report", () => ({ normalizeActualAgencyFinancialMonth: (month: string) => month }));
import DashboardPage from "@/app/(app)/dashboard/page";
describe("Home independent data sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transactions.mockResolvedValue([{ id: "synthetic", employeeId: "employee", employee: "Worker", checkDate: "2026-09-01", checkNumber: "Synthetic", periodBegin: "2026-08-01", periodEnd: "2026-08-15", hours: "2", gross: "100", internalAmount: "80", agencyAdditional: "20" }]);
    mocks.budgets.mockResolvedValue([]); mocks.board.mockResolvedValue([]); mocks.strategies.mockResolvedValue({ rows: [] }); mocks.views.mockResolvedValue([]);
  });
  it("keeps working transaction and budget sections when Financial Setup rejects", async () => {
    mocks.strategies.mockRejectedValue(new Error("isolated strategy failure"));
    const page = await DashboardPage({ searchParams: Promise.resolve({}) }) as ReactElement<{ summary: OwnerDashboardSummary; unavailableSections: string[] }>;
    expect(page.props.unavailableSections).toEqual(["Financial setup"]);
    expect(page.props.summary.transactions.contextTotals.gross).toBe("100.00");
    expect(page.props.summary.transactions.contextTotals.transactions).toBe(1);
    expect(mocks.budgets).toHaveBeenCalledOnce(); expect(mocks.board).toHaveBeenCalledOnce();
  });
  it("identifies each failed section separately instead of displaying fallback zeros", async () => {
    mocks.transactions.mockRejectedValue(new Error("isolated transaction failure")); mocks.board.mockRejectedValue(new Error("isolated budget failure")); mocks.views.mockRejectedValue(new Error("isolated saved view failure"));
    const page = await DashboardPage({ searchParams: Promise.resolve({}) }) as ReactElement<{ unavailableSections: string[] }>;
    expect(page.props.unavailableSections).toEqual(["Transactions", "Budgets", "Saved views"]);
    expect(mocks.strategies).toHaveBeenCalledOnce();
  });
});
