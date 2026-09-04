/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * On boot we apply any outstanding database migrations (see auto-migrate.ts),
 * so a fresh deployment reaches the expected schema without an operator having
 * to reach an admin endpoint. Node runtime only; the edge runtime never loads
 * the Postgres driver.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runMigrationsOnce } = await import("./lib/db/auto-migrate");
    await runMigrationsOnce();
    const { ensurePostMigrationTasks } = await import("./lib/db/post-migrate");
    await ensurePostMigrationTasks();
  }
}
