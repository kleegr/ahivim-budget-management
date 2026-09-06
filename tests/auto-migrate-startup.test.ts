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
    mocks.migrationChecksumMatches.mockReset().mockReturnValue(true);
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
    query.mockResolvedValue({ rows: [currentRow] });
    await expect(runMigrationsOnce()).resolves.toBeUndefined();
    expect(mocks.runMigrations).toHaveBeenCalledTimes(1);
  });

  it("retries an auto-managed schema read failure without starting the migration runner", async () => {
    const query = vi.fn()
      .mockRejectedValueOnce({ type: "error" })
      .mockResolvedValueOnce({ rows: [currentRow] });
    mocks.getPool.mockReturnValue({ query });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const startup = runMigrationsOnce();
    await vi.advanceTimersByTimeAsync(250);

    await expect(startup).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("shares one in-flight promise while an auto-managed schema retry is pending", async () => {
    const query = vi.fn()
      .mockRejectedValueOnce({ type: "error" })
      .mockResolvedValueOnce({ rows: [currentRow] });
    mocks.getPool.mockReturnValue({ query });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const first = runMigrationsOnce();
    const second = runMigrationsOnce();
    expect(second).toBe(first);

    await vi.advanceTimersByTimeAsync(250);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("retries a transient migration connection failure after a confirmed-behind check", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    mocks.getPool.mockReturnValue({ query });
    mocks.runMigrations
      .mockRejectedValueOnce({ type: "error" })
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const startup = runMigrationsOnce();
    await vi.advanceTimersByTimeAsync(250);

    await expect(startup).resolves.toBeUndefined();
    expect(mocks.runMigrations).toHaveBeenCalledTimes(2);
  });

  it("fails closed after bounded auto-managed retries, then lets a healthy later call recover", async () => {
    const query = vi.fn().mockRejectedValue({ type: "error" });
    mocks.getPool.mockReturnValue({ query });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const first = runMigrationsOnce();
    const rejection = expect(first).rejects.toThrow(
      /temporary database failure.*could not be verified after 8 attempts.*event=error/i,
    );
    await vi.runAllTimersAsync();
    await rejection;
    expect(query).toHaveBeenCalledTimes(8);
    expect(mocks.runMigrations).not.toHaveBeenCalled();

    query.mockResolvedValue({ rows: [currentRow] });
    const recovered = runMigrationsOnce();
    expect(recovered).not.toBe(first);
    await expect(recovered).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(9);
  });

  it("fails closed after all transient migration attempts, then recovers on an exact-current read", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    mocks.getPool.mockReturnValue({ query });
    mocks.runMigrations.mockRejectedValue({ type: "error" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const first = runMigrationsOnce();
    const rejection = expect(first).rejects.toThrow(/temporary database failure.*event=error/i);
    await vi.runAllTimersAsync();
    await rejection;
    expect(mocks.runMigrations).toHaveBeenCalledTimes(4);

    query.mockResolvedValue({ rows: [currentRow] });
    const recovered = runMigrationsOnce();
    expect(recovered).not.toBe(first);
    await expect(recovered).resolves.toBeUndefined();
    expect(mocks.runMigrations).toHaveBeenCalledTimes(4);
  });

  it("keeps a checksum mismatch sticky and never calls the migration runner", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [currentRow] });
    mocks.getPool.mockReturnValue({ query });
    mocks.migrationChecksumMatches.mockReturnValue(false);
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const first = runMigrationsOnce();
    await expect(first).rejects.toThrow(/checksum mismatch/i);
    const second = runMigrationsOnce();
    expect(second).toBe(first);
    await expect(second).rejects.toThrow(/checksum mismatch/i);
    expect(query).toHaveBeenCalledTimes(1);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("keeps a permanent database configuration failure sticky and does not retry or migrate", async () => {
    const authenticationFailure = Object.assign(new Error("password authentication failed"), { code: "28P01" });
    mocks.getPool.mockImplementation(() => {
      throw authenticationFailure;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const first = runMigrationsOnce();
    await expect(first).rejects.toThrow(/schema validation failed.*code=28P01/i);
    const second = runMigrationsOnce();
    expect(second).toBe(first);
    await expect(second).rejects.toThrow(/code=28P01/i);
    expect(mocks.getPool).toHaveBeenCalledTimes(1);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("keeps a missing connection string sticky instead of treating its wording as a network failure", async () => {
    mocks.getPool.mockImplementation(() => {
      throw new Error("No database connection string found. Set DATABASE_URL.");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const first = runMigrationsOnce();
    await expect(first).rejects.toThrow(/schema validation failed.*No database connection string found/i);
    expect(runMigrationsOnce()).toBe(first);
    expect(mocks.getPool).toHaveBeenCalledTimes(1);
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it("waits through an intermittent lock-loser read failure until the exact ledger is current", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce({ type: "error" })
      .mockResolvedValueOnce({ rows: [currentRow] });
    mocks.getPool.mockReturnValue({ query });
    mocks.runMigrations.mockRejectedValueOnce(new mocks.MigrationLockUnavailableError());
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const startup = runMigrationsOnce();
    await vi.advanceTimersByTimeAsync(500);

    await expect(startup).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(3);
    expect(mocks.runMigrations).toHaveBeenCalledTimes(1);
  });

  it("treats a missing migration ledger as confirmed behind and initializes it", async () => {
    const missingLedger = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const query = vi.fn().mockRejectedValueOnce(missingLedger);
    mocks.getPool.mockReturnValue({ query });
    mocks.runMigrations.mockResolvedValueOnce({ applied: 1, skipped: 0 });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    await expect(runMigrationsOnce()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(mocks.runMigrations).toHaveBeenCalledTimes(1);
  });

  it("keeps a permanent migration error rejected instead of serving", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    mocks.getPool.mockReturnValue({ query });
    mocks.runMigrations.mockRejectedValueOnce(new Error("permission denied"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    await expect(runMigrationsOnce()).rejects.toThrow(
      /database migrations failed; startup was stopped: type=Error message=permission denied/i,
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
    const transient = Object.assign(new Error("database connection unavailable"), { code: "57P03" });
    const query = vi.fn().mockRejectedValue(transient);
    mocks.getPool.mockReturnValue({ query });
    process.env.DISABLE_AUTO_MIGRATE = "1";
    const { runMigrationsOnce } = await import("@/lib/db/auto-migrate");

    const startup = runMigrationsOnce();
    const rejection = expect(startup).rejects.toThrow(/could not verify the database schema after 8 attempts/i);
    await vi.runAllTimersAsync();

    await rejection;
    expect(query).toHaveBeenCalledTimes(8);
    expect(mocks.runMigrations).not.toHaveBeenCalled();

    query.mockResolvedValue({ rows: [currentRow] });
    await expect(runMigrationsOnce()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(9);
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
