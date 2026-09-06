import { createRequire } from "node:module";
import path from "node:path";
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

interface NextInstrumentationWrapper {
  ensureInstrumentationRegistered(projectDir: string, distDir: string): Promise<void>;
}

interface InstrumentationTestGlobal {
  __ahivimInstrumentationRegister?: () => Promise<void>;
}

const testGlobal = globalThis as typeof globalThis & InstrumentationTestGlobal;

describe("Next instrumentation registration cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.runMigrationsOnce.mockReset();
    mocks.ensurePostMigrationTasks.mockReset();
    process.env.NEXT_RUNTIME = "nodejs";
  });

  afterEach(() => {
    delete testGlobal.__ahivimInstrumentationRegister;
    delete process.env.NEXT_RUNTIME;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lets Next's one cached registration promise recover from a transient outage", async () => {
    mocks.runMigrationsOnce
      .mockRejectedValueOnce(new mocks.StartupDatabaseUnavailableError("database is waking"))
      .mockResolvedValueOnce(undefined);
    mocks.ensurePostMigrationTasks.mockResolvedValueOnce(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { register } = await import("../src/instrumentation");
    testGlobal.__ahivimInstrumentationRegister = register;

    const require = createRequire(import.meta.url);
    const nextInstrumentation = require(
      "next/dist/server/lib/router-utils/instrumentation-globals.external.js"
    ) as NextInstrumentationWrapper;
    const fixtureRoot = path.resolve(
      process.cwd(),
      "tests/fixtures/next-instrumentation-cache",
    );

    const first = nextInstrumentation.ensureInstrumentationRegistered(fixtureRoot, "dist");
    const second = nextInstrumentation.ensureInstrumentationRegistered(fixtureRoot, "dist");
    expect(second).toBe(first);

    await vi.runAllTimersAsync();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(mocks.runMigrationsOnce).toHaveBeenCalledTimes(2);
    expect(mocks.ensurePostMigrationTasks).toHaveBeenCalledTimes(1);
  });
});
