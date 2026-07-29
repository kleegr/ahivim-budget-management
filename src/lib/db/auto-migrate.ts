import { getPool } from "./index";
import { runMigrations } from "./migrate";

/**
 * Apply outstanding migrations once, at server start-up.
 *
 * Production has no shell and no reachable admin endpoint for an operator here,
 * so the deployed app migrates its own database on boot. This is safe because:
 *
 *   - the runner is idempotent (each file applies once, checksummed, skipped
 *     thereafter), so a warm database is a no-op;
 *   - a Postgres advisory lock serialises concurrent lambda cold starts, so two
 *     instances can never apply the same migration at once;
 *   - it never runs more than once per process (the module-level guard), so warm
 *     invocations pay nothing;
 *   - failure is caught and logged — it can never crash the app;
 *   - migrations are additive and data-preserving (verified on a data-bearing
 *     database).
 *
 * Set DISABLE_AUTO_MIGRATE=1 to turn this off and apply migrations manually
 * (Settings → Database, or `npm run db:migrate`) instead.
 */

let started = false;
// A fixed, arbitrary key so every instance contends for the same lock.
const MIGRATION_ADVISORY_LOCK = 471114723;

export async function runMigrationsOnce(): Promise<void> {
  if (started) return;
  started = true;
  if (process.env.DISABLE_AUTO_MIGRATE === "1") return;

  // No connection string (e.g. a build step) → nothing to do.
  let client;
  try {
    client = await getPool().connect();
  } catch {
    return;
  }

  try {
    // Blocks only until any other booting instance finishes its run.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK]);
    const result = await runMigrations();
    console.log(`[auto-migrate] applied=${result.applied} skipped=${result.skipped}`);
  } catch (error) {
    console.error(
      "[auto-migrate] migrations did not complete:",
      error instanceof Error ? error.message : "unknown error",
    );
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK]);
    } catch {
      /* the lock releases with the session anyway */
    }
    client.release();
  }
}
