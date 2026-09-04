import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  ensureMigrationsApplied: vi.fn(),
  getPool: vi.fn(),
  getSyncConfig: vi.fn(),
  runSheetSync: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db/auto-migrate", () => ({ ensureMigrationsApplied: mocks.ensureMigrationsApplied }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/sheets/config", () => ({ getSyncConfig: mocks.getSyncConfig }));
vi.mock("@/lib/sheets/sync", () => ({ runSheetSync: mocks.runSheetSync }));

import { GET } from "@/app/api/sync/cron/route";

const ORIGINAL_SECRET = process.env.CRON_SECRET;

describe("scheduled sync authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CRON_SECRET;
    mocks.apiUser.mockResolvedValue(null);
    mocks.ensureMigrationsApplied.mockResolvedValue(null);
    mocks.getPool.mockReturnValue({ query: vi.fn(async () => ({ rows: [] })) });
    mocks.getSyncConfig.mockResolvedValue({
      enabled: true,
      minIntervalMinutes: 0,
      scheduleHourUtc: new Date().getUTCHours(),
    });
    mocks.runSheetSync.mockResolvedValue({
      runId: "run-1",
      status: "success",
      trigger: "scheduled",
      sourceRows: 12,
      added: 2,
      updated: 0,
      skipped: 10,
      flagged: 0,
      failed: 0,
      changed: 0,
      missing: 0,
      importBatchId: "batch-1",
      reconciliation: {
        importedAgencyGross: "25000.0000",
        importedInternalAmount: "21000.0000",
      },
      error: null,
      note: "Sensitive operational detail",
    });
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  it("fails closed before database work when CRON_SECRET is missing", async () => {
    const response = await GET(new NextRequest("http://localhost/api/sync/cron"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ ok: false, error: "Unauthorized" });
    expect(mocks.ensureMigrationsApplied).not.toHaveBeenCalled();
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.getSyncConfig).not.toHaveBeenCalled();
    expect(mocks.runSheetSync).not.toHaveBeenCalled();
  });

  it("does not accept a cron secret in the query string", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const response = await GET(new NextRequest(
      "http://localhost/api/sync/cron?key=cron-secret",
    ));

    expect(response.status).toBe(401);
    expect(mocks.ensureMigrationsApplied).not.toHaveBeenCalled();
    expect(mocks.runSheetSync).not.toHaveBeenCalled();
  });

  it("returns details to a Vercel cron request with the configured bearer secret", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const response = await GET(new NextRequest("http://localhost/api/sync/cron", {
      headers: { authorization: "Bearer cron-secret" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.authorisedBy).toBe("cron_secret");
    expect(body.summary.reconciliation.importedAgencyGross).toBe("25000.0000");
    expect(mocks.apiUser).not.toHaveBeenCalled();
  });

  it("allows an explicitly authenticated administrator when no secret is configured", async () => {
    mocks.apiUser.mockResolvedValue({ id: "admin-1", actorId: "owner-1" });

    const response = await GET(new NextRequest("http://localhost/api/sync/cron"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.authorisedBy).toBe("admin_session");
    expect(mocks.runSheetSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "owner-1" }),
    );
  });
});
