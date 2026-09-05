import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runMigrationsOnce: vi.fn(),
  ensurePostMigrationTasks: vi.fn(),
}));

vi.mock("@/lib/db/auto-migrate", () => ({
  runMigrationsOnce: mocks.runMigrationsOnce,
}));
vi.mock("@/lib/db/post-migrate", () => ({
  ensurePostMigrationTasks: mocks.ensurePostMigrationTasks,
}));

describe("instrumentation migration gate", () => {
  beforeEach(() => {
    mocks.runMigrationsOnce.mockReset();
    mocks.ensurePostMigrationTasks.mockReset();
    process.env.NEXT_RUNTIME = "nodejs";
  });

  afterEach(() => {
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
});
