/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * On boot we apply any outstanding database migrations (see auto-migrate.ts),
 * so a fresh deployment reaches the expected schema without an operator having
 * to reach an admin endpoint. Node runtime only; the edge runtime never loads
 * the Postgres driver.
 */
const STARTUP_TRANSIENT_RETRY_MS = 1_000;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runMigrationsOnce, StartupDatabaseUnavailableError } = await import(
      "./lib/db/auto-migrate"
    );
    let transientFailureCount = 0;

    // Next memoises its instrumentation-registration promise for the lifetime
    // of the process, including a rejected promise. Keep that outer promise
    // pending through temporary database outages so the same warm process can
    // recover. Deterministic schema, checksum, authentication and configuration
    // failures still reject immediately and remain fail-closed.
    while (true) {
      try {
        await runMigrationsOnce();
        break;
      } catch (error) {
        if (!(error instanceof StartupDatabaseUnavailableError)) throw error;
        transientFailureCount += 1;
        console.warn(JSON.stringify({
          event: "instrumentation_migration_retry",
          transientFailureCount,
          retryInMs: STARTUP_TRANSIENT_RETRY_MS,
        }));
        await new Promise((resolve) => setTimeout(resolve, STARTUP_TRANSIENT_RETRY_MS));
      }
    }
    const { ensurePostMigrationTasks } = await import("./lib/db/post-migrate");
    await ensurePostMigrationTasks();
  }
}
