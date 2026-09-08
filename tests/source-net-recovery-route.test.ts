import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(), getPool: vi.fn(), sameOriginOrFail: vi.fn(), readJson: vi.fn(),
  recoverSourceNet: vi.fn(), refreshSettlementObligations: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/sheets/net-recovery", () => ({ recoverSourceNet: mocks.recoverSourceNet }));
vi.mock("@/lib/manage/settlements", () => ({ refreshSettlementObligations: mocks.refreshSettlementObligations }));
vi.mock("@/lib/http", () => ({
  sameOriginOrFail: mocks.sameOriginOrFail, readJson: mocks.readJson,
  redactError: (_error: unknown, fallback: string) => fallback,
  jsonError: (error: string, status: number) => Response.json({ ok: false, error }, { status }),
  resultResponse: (result: unknown) => Response.json(result),
}));

import { POST } from "@/app/api/sync/conflicts/[id]/net-recovery/route";
const pool = { query: vi.fn(), connect: vi.fn() };
const conflictId = "00000000-0000-4000-8000-000000000031";
const actorId = "00000000-0000-4000-8000-000000000032";
const effectiveId = "00000000-0000-4000-8000-000000000033";
const context = { params: Promise.resolve({ id: conflictId }) };
const request = () => new NextRequest(`http://localhost/api/sync/conflicts/${conflictId}/net-recovery`, { method: "POST" });

describe("Source NET recovery route authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sameOriginOrFail.mockReturnValue(null);
    mocks.apiUser.mockResolvedValue({ id: effectiveId, actorId, role: "manager" });
    mocks.getPool.mockReturnValue(pool);
    mocks.readJson.mockResolvedValue({ action: "accept", reason: "Exact source reviewed", operationKey: "operation-1" });
    mocks.recoverSourceNet.mockResolvedValue({ ok: true, data: { transactionId: "transaction-1", acceptanceAuditId: "audit-1", auditId: "audit-1", net: "0.0000", alreadyApplied: false } });
  });

  it("rejects origin before authentication, request-body parsing, or database access", async () => {
    mocks.sameOriginOrFail.mockReturnValue(Response.json({ ok: false }, { status: 403 }));
    expect((await POST(request(), context)).status).toBe(403);
    expect(mocks.apiUser).not.toHaveBeenCalled();
    expect(mocks.readJson).not.toHaveBeenCalled();
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.recoverSourceNet).not.toHaveBeenCalled();
  });

  it.each(["signed out", "budget planner", "money collector", "viewer", "custom restricted access", "owner signed in as restricted target"])(
    "honors the session guard's denial for %s before reading data", async () => {
      // Preset/session resolution belongs to apiUser; this route must honor
      // its denial without accessing the source through the owner's identity.
      mocks.apiUser.mockResolvedValue(null);
      expect((await POST(request(), context)).status).toBe(403);
      expect(mocks.apiUser).toHaveBeenCalledExactlyOnceWith("manager");
      expect(mocks.sameOriginOrFail.mock.invocationCallOrder[0]).toBeLessThan(mocks.apiUser.mock.invocationCallOrder[0]);
      expect(mocks.readJson).not.toHaveBeenCalled();
      expect(mocks.getPool).not.toHaveBeenCalled();
      expect(mocks.recoverSourceNet).not.toHaveBeenCalled();
      expect(mocks.refreshSettlementObligations).not.toHaveBeenCalled();
    },
  );

  for (const role of ["manager", "admin"]) {
    for (const action of ["accept", "undo"]) {
      it(`${role} ${action} records the actual actor, preserves zero and never refreshes settlements`, async () => {
        mocks.apiUser.mockResolvedValue({ id: effectiveId, actorId, role });
        const input = { action, reason: "Exact source reviewed", operationKey: "operation-1", ...(action === "undo" ? { acceptanceAuditId: "accepted-audit" } : {}) };
        mocks.readJson.mockResolvedValue(input);
        const response = await POST(request(), context);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, data: { net: "0.0000" } });
        expect(mocks.apiUser).toHaveBeenCalledExactlyOnceWith("manager");
        expect(mocks.sameOriginOrFail.mock.invocationCallOrder[0]).toBeLessThan(mocks.apiUser.mock.invocationCallOrder[0]);
        expect(mocks.recoverSourceNet).toHaveBeenCalledExactlyOnceWith(pool, conflictId, { ...input, acceptanceAuditId: action === "undo" ? "accepted-audit" : undefined }, actorId);
        expect(mocks.refreshSettlementObligations).not.toHaveBeenCalled();
      });
    }
  }

  it("rejects an unsupported action without opening the database", async () => {
    mocks.readJson.mockResolvedValue({ action: "verify_check" });
    expect((await POST(request(), context)).status).toBe(400);
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.recoverSourceNet).not.toHaveBeenCalled();
  });
});
