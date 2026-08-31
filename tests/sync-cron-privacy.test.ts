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

describe("scheduled sync response privacy", () => {
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

  it("returns status only when the trigger is intentionally open", async () => {
    const response = await GET(new NextRequest("http://localhost/api/sync/cron"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, ran: true, status: "success" });
    expect(JSON.stringify(body)).not.toMatch(/25000|21000|batch-1|Sensitive/);
  });

  it("returns details to the authenticated Vercel cron request", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const response = await GET(new NextRequest("http://localhost/api/sync/cron", {
      headers: { authorization: "Bearer cron-secret" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary.reconciliation.importedAgencyGross).toBe("25000.0000");
    expect(mocks.apiUser).not.toHaveBeenCalled();
  });
});
