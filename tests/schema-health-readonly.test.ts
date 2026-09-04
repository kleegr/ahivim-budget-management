import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  ensureMigrationsApplied: vi.fn(),
  ensurePostMigrationTasks: vi.fn(),
  listTables: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/db/migrate", () => ({
  LEDGER_TABLE: "_ahivim_migrations",
  listTables: mocks.listTables,
}));
vi.mock("@/lib/db/migrations.generated", () => ({
  MIGRATIONS: [{ name: "0001_test", sql: "SELECT 1" }],
}));
vi.mock("@/lib/db/migration-checksum", () => ({
  migrationChecksumMatches: () => true,
}));
vi.mock("@/lib/db/auto-migrate", () => ({
  ensureMigrationsApplied: mocks.ensureMigrationsApplied,
}));
vi.mock("@/lib/db/post-migrate", () => ({
  ensurePostMigrationTasks: mocks.ensurePostMigrationTasks,
}));

import { GET } from "@/app/api/health/schema/route";

describe("schema health is read-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiUser.mockResolvedValue(null);
    mocks.query.mockResolvedValue({
      rows: [{ name: "0001_test", checksum: "matching-checksum" }],
    });
  });

  it("checks the migration ledger without running maintenance", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, healthy: true });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.ensureMigrationsApplied).not.toHaveBeenCalled();
    expect(mocks.ensurePostMigrationTasks).not.toHaveBeenCalled();
    expect(mocks.listTables).not.toHaveBeenCalled();
  });

  it("preserves the public unhealthy response when admin lookup also fails", async () => {
    mocks.query.mockRejectedValueOnce(new Error("ledger unavailable"));
    mocks.apiUser.mockRejectedValueOnce(new Error("session lookup unavailable"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, healthy: false });
    expect(mocks.listTables).not.toHaveBeenCalled();
  });

  it("does not import maintenance triggers into the public route", () => {
    const source = readFileSync(path.join(
      process.cwd(),
      "src",
      "app",
      "api",
      "health",
      "schema",
      "route.ts",
    ), "utf8");

    expect(source).not.toContain("ensureMigrationsApplied");
    expect(source).not.toContain("ensurePostMigrationTasks");
  });
});
