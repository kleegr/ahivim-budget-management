import { getPool } from "./index";
import { runMigrations } from "./migrate";

/**
 * Apply outstanding migrations on the deployed instance.
 *
 * Production has no shell and no reachable admin endpoint for an operator here,
 * so the deployed app migrates its own database. This is safe because:
 *
 *   - the runner is idempotent (each file applies once, checksummed, skipped
 *     thereafter), so a warm database is a no-op;
 *   - a Postgres advisory lock serialises concurrent cold starts, so two
 *     instances can never apply the same migration at once;
 *   - failure is caught and logged — it can never crash the app;
 *   - migrations are additive and data-preserving (verified on a data-bearing
 *     database).
 *
 * Two entry points share the same core:
 *   - `runMigrationsOnce()` runs from the instrumentation hook at server start
 *     and honours DISABLE_AUTO_MIGRATE (opt-out for manual migration).
 *   - `ensureMigrationsApplied()` is an explicit, idempotent trigger invoked
 *     from the schema health check, so a plain authenticated-free GET can bring
 *     a fresh deployment's schema current even when the boot hook did not. It
 *     does NOT honour the opt-out, because it is only reached deliberately.
 */

const MIGRATION_ADVISORY_LOCK = 471114723;

export interface MigrateOutcome {
  ran: boolean;
  applied: number;
  skipped: number;
  ok: boolean;
  error?: string;
}

async function applyPendingMigrations(): Promise<MigrateOutcome> {
  let client;
  try {
    client = await getPool().connect();
  } catch (error) {
    return { ran: false, applied: 0, skipped: 0, ok: false, error: error instanceof Error ? error.message : "connect failed" };
  }
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK]);
    const result = await runMigrations();
    console.log(`[auto-migrate] applied=${result.applied} skipped=${result.skipped}`);
    return { ran: true, applied: result.applied, skipped: result.skipped, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error("[auto-migrate] migrations did not complete:", message);
    return { ran: true, applied: 0, skipped: 0, ok: false, error: message };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK]);
    } catch {
      /* the lock releases with the session anyway */
    }
    client.release();
  }
}

let bootStarted = false;

/** Instrumentation-hook entry point. Honours DISABLE_AUTO_MIGRATE; runs once per process. */
export async function runMigrationsOnce(): Promise<void> {
  if (bootStarted) return;
  bootStarted = true;
  if (process.env.DISABLE_AUTO_MIGRATE === "1") return;
  await applyPendingMigrations();
}

let ensured: Promise<MigrateOutcome> | null = null;

/**
 * Explicit, idempotent "make the schema current" trigger. Safe to call on every
 * request — the work runs once per process (memoised) and is a no-op against a
 * warm database. Reached from the schema health check.
 */
export function ensureMigrationsApplied(): Promise<MigrateOutcome> {
  if (!ensured) ensured = applyPendingMigrations();
  return ensured;
}
