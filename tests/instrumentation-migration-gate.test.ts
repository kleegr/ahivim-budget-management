import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class StartupDatabaseUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "StartupDatabaseUnavailableError";
    }
  }

  return {
    runMigrationsOnce: vi.fn(),
    ensurePostMigrationTasks: vi.fn(),
    StartupDatabaseUnavailableError,
  };
});

vi.mock("@/lib/db/auto-migrate", () => ({
  runMigrationsOnce: mocks.runMigrationsOnce,
  StartupDatabaseUnavailableError: mocks.StartupDatabaseUnavailableError,
}));
vi.mock("@/lib/db/post-migrate", () => ({
  ensurePostMigrationTasks: mocks.ensurePostMigrationTasks,
}));

describe("instrumentation migration gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.runMigrationsOnce.mockReset();
    mocks.ensurePostMigrationTasks.mockReset();
    process.env.NEXT_RUNTIME = "nodejs";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.NEXT_RUNTIME;
  });

  it("does not start post-migration work when schema startup fails", async () => {
    mocks.runMigrationsOnce.mockRejectedValueOnce(new Error("schema behind"));
    const { register } = await import("../src/instrumentation");

    await expect(register()).rejects.toThrow("schema behind");
    expect(mocks.ensurePostMigrationTasks).not.toHaveBeenCalled();
  });

  it("starts post-migration work only after the schema gate succeeds", async () => {
    mocks.runMigrationsOnce.mockResolvedValueOnce(undefined);
    mocks.ensurePostMigrationTasks.mockResolvedValueOnce(undefined);
    const { register } = await import("../src/instrumentation");

    await expect(register()).resolves.toBeUndefined();
    expect(mocks.runMigrationsOnce).toHaveBeenCalledTimes(1);
    expect(mocks.ensurePostMigrationTasks).toHaveBeenCalledTimes(1);
    expect(mocks.runMigrationsOnce.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensurePostMigrationTasks.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps startup pending and retries after a temporary database outage", async () => {
    mocks.runMigrationsOnce
      .mockRejectedValueOnce(new mocks.StartupDatabaseUnavailableError("database is waking"))
      .mockResolvedValueOnce(undefined);
    mocks.ensurePostMigrationTasks.mockResolvedValueOnce(undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { register } = await import("../src/instrumentation");

    const registration = register();
    await vi.runAllTimersAsync();

    await expect(registration).resolves.toBeUndefined();
    expect(mocks.runMigrationsOnce).toHaveBeenCalledTimes(2);
    expect(mocks.ensurePostMigrationTasks).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(JSON.stringify({
      event: "instrumentation_migration_retry",
      transientFailureCount: 1,
      retryInMs: 1_000,
    }));
  });
});
