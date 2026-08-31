import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSettlementOperator: vi.fn(),
  sameOriginOrFail: vi.fn(),
  syncImportedPayrollCheckReviews: vi.fn(),
  refreshSettlementObligations: vi.fn(),
  settlementRefreshBlockingIssueMessage: vi.fn(),
}));

vi.mock("@/lib/auth/settlement-operator", () => ({
  getSettlementOperator: mocks.getSettlementOperator,
}));
vi.mock("@/lib/http", () => ({
  sameOriginOrFail: mocks.sameOriginOrFail,
  redactError: (_error: unknown, fallback: string) => fallback,
  jsonError: (message: string, status: number) => Response.json({ ok: false, error: message }, { status }),
}));
vi.mock("@/lib/manage/direct-pay-operations", () => ({
  syncImportedPayrollCheckReviews: mocks.syncImportedPayrollCheckReviews,
}));
vi.mock("@/lib/manage/settlements", () => ({
  refreshSettlementObligations: mocks.refreshSettlementObligations,
  settlementRefreshBlockingIssueMessage: mocks.settlementRefreshBlockingIssueMessage,
}));

import { POST } from "@/app/api/payroll-checks/import-reviews/route";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const pool = { query: vi.fn(), connect: vi.fn() };

function request() {
  return new NextRequest("http://localhost/api/payroll-checks/import-reviews", { method: "POST" });
}

describe("historical imported-check repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sameOriginOrFail.mockReturnValue(null);
    mocks.getSettlementOperator.mockResolvedValue({
      pool,
      user: { id: ACTOR },
      scope: {
        allEmployees: true,
        allIndividuals: true,
        canSeeCheckNet: true,
        canSeeTaxes: true,
      },
    });
    mocks.settlementRefreshBlockingIssueMessage.mockReturnValue(null);
  });

  it("does not refresh settlements when the read-only preflight finds nothing to repair", async () => {
    mocks.syncImportedPayrollCheckReviews.mockResolvedValue({ checks: 0, linkedTransactions: 0 });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.refreshSettlementObligations).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      ok: true,
      data: { checks: 0, linkedTransactions: 0 },
      settlementWarning: null,
      settlementRefreshSkipped: true,
    });
  });

  it("surfaces a successful refresh that left the ledger blocked as a warning", async () => {
    const refreshData = { skippedMissingNet: 2 };
    mocks.syncImportedPayrollCheckReviews.mockResolvedValue({ checks: 1, linkedTransactions: 3 });
    mocks.refreshSettlementObligations.mockResolvedValue({ ok: true, data: refreshData });
    mocks.settlementRefreshBlockingIssueMessage.mockReturnValue(
      "2 transactions are missing whole-check net pay.",
    );

    const response = await POST(request());
    const body = await response.json();

    expect(mocks.refreshSettlementObligations).toHaveBeenCalledWith(pool, {}, ACTOR);
    expect(mocks.settlementRefreshBlockingIssueMessage).toHaveBeenCalledWith(refreshData);
    expect(body).toMatchObject({
      ok: true,
      data: { checks: 1, linkedTransactions: 3 },
      settlementWarning: "2 transactions are missing whole-check net pay.",
      settlementRefreshSkipped: false,
    });
  });

  it("requires full roster and payroll-detail access", async () => {
    mocks.getSettlementOperator.mockResolvedValue({
      pool,
      user: { id: ACTOR },
      scope: {
        allEmployees: false,
        allIndividuals: true,
        canSeeCheckNet: true,
        canSeeTaxes: true,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mocks.syncImportedPayrollCheckReviews).not.toHaveBeenCalled();
  });
});
