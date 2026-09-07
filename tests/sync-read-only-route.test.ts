import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  runSheetSync: vi.fn(),
  setSyncConfig: vi.fn(),
  sameOriginOrFail: vi.fn(),
  readJson: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/sheets/sync", () => ({ runSheetSync: mocks.runSheetSync }));
vi.mock("@/lib/sheets/config", () => ({
  getSyncConfig: vi.fn(),
  setSyncConfig: mocks.setSyncConfig,
}));
vi.mock("@/lib/http", () => ({
  sameOriginOrFail: mocks.sameOriginOrFail,
  readJson: mocks.readJson,
  redactError: (_error: unknown, fallback: string) => fallback,
  jsonError: (message: string, status: number) => Response.json({ ok: false, error: message }, { status }),
}));

import { POST } from "@/app/api/sync/run/route";
import { PUT as PUT_CONFIG } from "@/app/api/sync/config/route";

const pool = { query: vi.fn(), connect: vi.fn() };

describe("manual Sheet refresh route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sameOriginOrFail.mockReturnValue(null);
    mocks.apiUser.mockResolvedValue({ id: "preview-target-1", actorId: "operator-1", role: "manager" });
    mocks.getPool.mockReturnValue(pool);
  });

  it("runs only the inbound sync and returns its recorded summary", async () => {
    const summary = {
      status: "no_changes",
      runId: "run-1",
      note: "The read-only source is unchanged.",
    };
    mocks.runSheetSync.mockResolvedValue(summary);

    const response = await POST(new NextRequest("http://localhost/api/sync/run", { method: "POST" }));
    const body = await response.json();

    expect(mocks.runSheetSync).toHaveBeenCalledWith(pool, {
      trigger: "manual",
      userId: "operator-1",
    });
    expect(body).toEqual({ ok: true, summary });
    expect(Object.keys(body)).toEqual(["ok", "summary"]);
  });

  it("keeps a recorded inbound failure as a structured domain result", async () => {
    const summary = { status: "failed", runId: "run-2", error: "Source unavailable." };
    mocks.runSheetSync.mockResolvedValue(summary);

    const response = await POST(new NextRequest("http://localhost/api/sync/run", { method: "POST" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: false, summary });
  });

  it("attributes a source-setting change to the owner behind a preview session", async () => {
    const config = { enabled: true, sheetId: "authoritative", sheetName: "Ahivim" };
    mocks.readJson.mockResolvedValue(config);
    mocks.setSyncConfig.mockResolvedValue(config);

    const response = await PUT_CONFIG(new NextRequest("http://localhost/api/sync/config", {
      method: "PUT",
    }));

    expect(response.status).toBe(200);
    expect(mocks.setSyncConfig).toHaveBeenCalledWith(pool, expect.objectContaining(config), "operator-1");
  });

  it("uses the real actor for every sync mutation behind owner preview", () => {
    const routes = [
      join("src", "app", "api", "sync", "run", "route.ts"),
      join("src", "app", "api", "sync", "config", "route.ts"),
      join("src", "app", "api", "sync", "conflicts", "[id]", "route.ts"),
      join("src", "app", "api", "sync", "history", "route.ts"),
    ];
    for (const route of routes) {
      const source = readFileSync(join(process.cwd(), route), "utf8");
      expect(source, route).toContain("user.actorId");
      expect(source, route).not.toMatch(/\buser\.id\b/);
    }
  });
});
