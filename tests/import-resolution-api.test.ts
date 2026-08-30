import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ROW_ID = "00000000-0000-4000-8000-000000000001";
const EXCEPTION_ID = "00000000-0000-4000-8000-000000000002";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  applyCorrectedImportRow: vi.fn(),
  acceptImportedRate: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/manage/import-corrections", () => ({
  applyCorrectedImportRow: mocks.applyCorrectedImportRow,
  correctRowFields: vi.fn(),
  resetRowCorrection: vi.fn(),
  resolveRowMatch: vi.fn(),
  setRowReviewStatus: vi.fn(),
}));
vi.mock("@/lib/manage/rate-exceptions", () => ({
  acceptImportedRate: mocks.acceptImportedRate,
}));

import { PATCH as patchImportRow } from "@/app/api/import-rows/[id]/route";
import { PATCH as patchRateException } from "@/app/api/rate-exceptions/[id]/route";

function request(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

describe("import resolution API authorization and actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPool.mockReturnValue({ name: "pool" });
  });

  it("denies correction and rate decisions before opening the database", async () => {
    mocks.apiUser.mockResolvedValue(null);

    const correction = await patchImportRow(
      request(`/api/import-rows/${ROW_ID}`, { action: "apply" }),
      { params: Promise.resolve({ id: ROW_ID }) },
    );
    const rate = await patchRateException(
      request(`/api/rate-exceptions/${EXCEPTION_ID}`, { action: "accept" }),
      { params: Promise.resolve({ id: EXCEPTION_ID }) },
    );

    expect(correction.status).toBe(403);
    expect(rate.status).toBe(403);
    expect(mocks.apiUser).toHaveBeenCalledWith("manager");
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.applyCorrectedImportRow).not.toHaveBeenCalled();
    expect(mocks.acceptImportedRate).not.toHaveBeenCalled();
  });

  it("routes an explicit manager apply operation with its audit reason", async () => {
    const pool = { name: "pool" };
    mocks.apiUser.mockResolvedValue({ id: "manager-1", role: "manager" });
    mocks.getPool.mockReturnValue(pool);
    mocks.applyCorrectedImportRow.mockResolvedValue({
      ok: true,
      data: {
        rowId: ROW_ID,
        transactionId: "00000000-0000-4000-8000-000000000003",
        serviceSessionId: "00000000-0000-4000-8000-000000000004",
        alreadyApplied: false,
        rateExceptionId: null,
      },
    });

    const response = await patchImportRow(
      request(`/api/import-rows/${ROW_ID}`, {
        action: "apply",
        rememberProgramAlias: true,
        reason: "Reviewed against source",
      }),
      { params: Promise.resolve({ id: ROW_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.applyCorrectedImportRow).toHaveBeenCalledWith(pool, ROW_ID, "manager-1", {
      rememberProgramAlias: true,
      reason: "Reviewed against source",
    });
  });

  it("records accepting an imported rate as a distinct manager decision", async () => {
    const pool = { name: "pool" };
    mocks.apiUser.mockResolvedValue({ id: "manager-1", role: "manager" });
    mocks.getPool.mockReturnValue(pool);
    mocks.acceptImportedRate.mockResolvedValue({
      ok: true,
      data: { id: EXCEPTION_ID, alreadyAccepted: false },
    });

    const response = await patchRateException(
      request(`/api/rate-exceptions/${EXCEPTION_ID}`, {
        action: "accept",
        reason: "Confirmed group-priced source",
      }),
      { params: Promise.resolve({ id: EXCEPTION_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.acceptImportedRate).toHaveBeenCalledWith(
      pool,
      EXCEPTION_ID,
      "manager-1",
      "Confirmed group-priced source",
    );
  });
});
