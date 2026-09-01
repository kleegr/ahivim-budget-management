import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  repairIssuedClassInvoiceProgramLink: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/manage/class-invoices", () => ({
  repairIssuedClassInvoiceProgramLink: mocks.repairIssuedClassInvoiceProgramLink,
}));

import { POST } from "@/app/api/agency-financials/class-invoices/[id]/link-program/route";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "22222222-2222-4222-8222-222222222222";
const BUDGET_ID = "33333333-3333-4333-8333-333333333333";
const PROGRAM_ID = "44444444-4444-4444-8444-444444444444";
const pool = { connect: vi.fn() };
const params = { params: Promise.resolve({ id: INVOICE_ID }) };

function request(body: Record<string, unknown>, origin?: string) {
  return new NextRequest(`http://localhost/api/agency-financials/class-invoices/${INVOICE_ID}/link-program`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("owner class-invoice program-link repair route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiUser.mockResolvedValue({ id: ACTOR_ID });
    mocks.getPool.mockReturnValue(pool);
    mocks.repairIssuedClassInvoiceProgramLink.mockResolvedValue({
      ok: true,
      data: { invoiceId: INVOICE_ID, classBudgetPeriodId: BUDGET_ID, programId: PROGRAM_ID },
    });
  });

  it("passes the exact expected budget and audit reason to the service", async () => {
    const response = await POST(request({
      classBudgetPeriodId: BUDGET_ID,
      reason: "Confirmed legacy import repair",
    }), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      data: { invoiceId: INVOICE_ID, classBudgetPeriodId: BUDGET_ID, programId: PROGRAM_ID },
    });
    expect(mocks.apiUser).toHaveBeenCalledWith("admin");
    expect(mocks.repairIssuedClassInvoiceProgramLink).toHaveBeenCalledWith(
      pool,
      INVOICE_ID,
      { classBudgetPeriodId: BUDGET_ID, reason: "Confirmed legacy import repair" },
      ACTOR_ID,
    );
  });

  it("denies non-owners before touching the repair service", async () => {
    mocks.apiUser.mockResolvedValue(null);

    const response = await POST(request({ classBudgetPeriodId: BUDGET_ID }), params);

    expect(response.status).toBe(403);
    expect(mocks.repairIssuedClassInvoiceProgramLink).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before touching the repair service", async () => {
    const response = await POST(
      request({ classBudgetPeriodId: BUDGET_ID }, "https://example.invalid"),
      params,
    );

    expect(response.status).toBe(403);
    expect(mocks.repairIssuedClassInvoiceProgramLink).not.toHaveBeenCalled();
  });

  it("returns the service conflict as a clear HTTP conflict", async () => {
    mocks.repairIssuedClassInvoiceProgramLink.mockResolvedValue({
      ok: false,
      code: "conflict",
      message: "This invoice is no longer linked to the selected class budget. Refresh and try again.",
    });

    const response = await POST(request({ classBudgetPeriodId: BUDGET_ID }), params);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      code: "conflict",
      error: expect.stringContaining("no longer linked"),
    });
  });
});
