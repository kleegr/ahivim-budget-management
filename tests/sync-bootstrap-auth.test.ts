import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  ensureMigrationsApplied: vi.fn(),
  getPool: vi.fn(),
  getSetting: vi.fn(),
  getSyncConfig: vi.fn(),
  query: vi.fn(),
  runSheetSync: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db/auto-migrate", () => ({
  ensureMigrationsApplied: mocks.ensureMigrationsApplied,
}));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/manage/app-settings", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));
vi.mock("@/lib/sheets/config", () => ({ getSyncConfig: mocks.getSyncConfig }));
vi.mock("@/lib/sheets/sync", () => ({ runSheetSync: mocks.runSheetSync }));

import * as bootstrapRoute from "@/app/api/sync/bootstrap/route";

const ORIGINAL_TOKEN = process.env.MIGRATION_TOKEN;

describe("initial sync bootstrap authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MIGRATION_TOKEN;
    mocks.apiUser.mockResolvedValue(null);
    mocks.ensureMigrationsApplied.mockResolvedValue(null);
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.getPool.mockReturnValue({ query: mocks.query });
    mocks.getSetting.mockResolvedValue(true);
    mocks.getSyncConfig.mockResolvedValue({ enabled: true });
    mocks.runSheetSync.mockResolvedValue({ status: "success" });
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.MIGRATION_TOKEN;
    else process.env.MIGRATION_TOKEN = ORIGINAL_TOKEN;
  });

  it("does not expose a mutating GET handler", () => {
    expect((bootstrapRoute as unknown as Record<string, unknown>).GET).toBeUndefined();
  });

  it("fails closed before database work when no token or admin session exists", async () => {
    const response = await bootstrapRoute.POST(new NextRequest(
      "http://localhost/api/sync/bootstrap",
      { method: "POST" },
    ));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "Unauthorized" });
    expect(mocks.ensureMigrationsApplied).not.toHaveBeenCalled();
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.getSetting).not.toHaveBeenCalled();
    expect(mocks.runSheetSync).not.toHaveBeenCalled();
  });

  it("accepts the configured first-deploy token only through its header", async () => {
    process.env.MIGRATION_TOKEN = "migration-secret";

    const response = await bootstrapRoute.POST(new NextRequest(
      "http://localhost/api/sync/bootstrap",
      {
        method: "POST",
        headers: { "x-migration-token": "migration-secret" },
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      alreadyDone: true,
      authorisedBy: "migration_token",
    });
    expect(mocks.apiUser).not.toHaveBeenCalled();
    expect(mocks.ensureMigrationsApplied).toHaveBeenCalledTimes(1);
  });

  it("ignores a migration token placed in the URL", async () => {
    process.env.MIGRATION_TOKEN = "migration-secret";

    const response = await bootstrapRoute.POST(new NextRequest(
      "http://localhost/api/sync/bootstrap?key=migration-secret",
      { method: "POST" },
    ));

    expect(response.status).toBe(401);
    expect(mocks.ensureMigrationsApplied).not.toHaveBeenCalled();
  });

  it("allows an authenticated administrator and records the actor", async () => {
    mocks.apiUser.mockResolvedValue({ id: "admin-1", actorId: "owner-1" });
    mocks.getSetting.mockResolvedValue(false);

    const response = await bootstrapRoute.POST(new NextRequest(
      "http://localhost/api/sync/bootstrap",
      { method: "POST" },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.authorisedBy).toBe("admin_session");
    expect(mocks.runSheetSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ trigger: "initial", userId: "owner-1" }),
    );
    expect(mocks.setSetting).toHaveBeenCalledWith(
      expect.anything(),
      "initial_sheet_sync_done",
      true,
      "owner-1",
    );
  });
});
