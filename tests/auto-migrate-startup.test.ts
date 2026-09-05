import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MigrationLockUnavailableError extends Error {
    constructor() {
      super("Another process is applying database migrations.");
      this.name = "MigrationLockUnavailableError";
    }
  }

  return {
    getPool: vi.fn(),
    migrationChecksumMatches: vi.fn(() => true),
    runMigrations: vi.fn(),
    MigrationLockUnavailableError,
  };
});

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/db/migrate", () => ({
  LEDGER_TABLE: "_ahivim_migrations",
  MigrationLockUnavailableError: mocks.MigrationLockUnavailableError,
  runMigrations: mocks.runMigrations,
}));
vi.mock("@/lib/db/migrations.generated", () => ({
  MIGRATIONS: [{ name: "0042_permission_granularity.sql", sql: "SELECT 1" }],
}));
vi.mock("@/lib/db/migration-checksum", () => ({
  migrationChecksumMatches: mocks.migrationChecksumMatches,
}));

const currentRow = {
  name: "0042_permission_granularity.sql",
  checksum: "current",
};

describe("startup migration gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    mocks.getPool.mockReset();
    mocks.migrationChecksumMatches.mockClear();
    mocks.runMigrations.mockReset();
    delete process.env.DISABLE_AUTO_MIGRATE;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.DISABLE_AUTO_MIGRATE;
  });

  it("shares the successful current-schema check across startup callers", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [currentRow] });
    mocks.getPool.mockReturnValue({ query });
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const first = runMigrationsOnce();
    const second = runMigrationsOnce();

    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("waits for a lock holder and continues only after the ledger is current", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [currentRow] });
    mocks.getPool.mockReturnValue({ query });
    mocks.runMigrations.mockRejectedValueOnce(new mocks.MigrationLockUnavailableError());
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const startup = runMigrationsOnce();
    await vi.advanceTimersByTimeAsync(250);

    await expect(startup).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    expect(mocks.runMigrations).toHaveBeenCalledWith(undefined, { waitForLock: false });
  });

  it("fails closed when a lock holder never brings the schema current", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    mocks.getPool.mockReturnValue({ query });
    mocks.runMigrations.mockRejectedValueOnce(new mocks.MigrationLockUnavailableError());
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const startup = runMigrationsOnce();
    const rejection = expect(startup).rejects.toThrow(/did not become current within 30000ms/i);
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    await expect(runMigrationsOnce()).rejects.toThrow(/did not become current/i);
    expect(mocks.runMigrations).toHaveBeenCalledTimes(1);
  });

  it("keeps a permanent migration error rejected instead of serving", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    mocks.getPool.mockReturnValue({ query });
    mocks.runMigrations.mockRejectedValueOnce(new Error("permission denied"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    await expect(runMigrationsOnce()).rejects.toThrow(
      /database migrations failed; startup was stopped: permission denied/i,
    );
    await expect(runMigrationsOnce()).rejects.toThrow(/permission denied/i);
    expect(mocks.runMigrations).toHaveBeenCalledTimes(1);
  });

  it("allows disabled auto-migration only after a read-only current-schema check", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [currentRow] });
    mocks.getPool.mockReturnValue({ query });
    process.env.DISABLE_AUTO_MIGRATE = "1";
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    await expect(runMigrationsOnce()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("retries a transient externally managed schema check before serving", async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error("database is waking"))
      .mockResolvedValueOnce({ rows: [currentRow] });
    mocks.getPool.mockReturnValue({ query });
    process.env.DISABLE_AUTO_MIGRATE = "1";
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const startup = runMigrationsOnce();
    await vi.advanceTimersByTimeAsync(250);

    await expect(startup).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("fails closed after bounded retries when the schema cannot be checked", async () => {
    const query = vi.fn().mockRejectedValue(new Error("database unavailable"));
    mocks.getPool.mockReturnValue({ query });
    process.env.DISABLE_AUTO_MIGRATE = "1";
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const startup = runMigrationsOnce();
    const rejection = expect(startup).rejects.toThrow(/could not verify the database schema after 4 attempts/i);
    await vi.advanceTimersByTimeAsync(750);

    await rejection;
    await expect(runMigrationsOnce()).rejects.toThrow(/after 4 attempts/i);
    expect(query).toHaveBeenCalledTimes(4);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("rejects a behind schema without mutating when auto-migration is disabled", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    mocks.getPool.mockReturnValue({ query });
    process.env.DISABLE_AUTO_MIGRATE = "1";
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    await expect(runMigrationsOnce()).rejects.toThrow(
      /requires every shipped migration to be pre-applied; the database schema is not current/i,
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });
});
