import { getPool } from "./index";
import { runMigrations, LEDGER_TABLE } from "./migrate";
import { MIGRATIONS } from "./migrations.generated";

/**
 * Apply outstanding migrations on the deployed instance — safely, and WITHOUT
 * adding latency (or a hang) to the request hot path.
 *
 * The earlier version took a *blocking* `pg_advisory_lock` on every cold start.
 * On serverless that is dangerous: an instance that acquires the lock and is
 * then frozen holds it, and every other cold start blocks on the lock until the
 * 300 s function timeout — which is exactly the production 504 we saw on
 * /individuals/[id], /settings and /aliases.
 *
 * The fix:
 *   1. Fast path — a single lock-free SELECT checks whether every shipped
 *      migration is already recorded. When the schema is current (the normal
 *      case) we return immediately: no lock, no work, ~1 cheap query.
 *   2. Behind path (only right after a deploy that ships a new migration) — take
 *      a NON-blocking `pg_try_advisory_lock`. If another instance already holds
 *      it, we skip instead of blocking; the schema will be current momentarily.
 *
 * Still idempotent, still crash-safe, still self-healing on deploy.
 */

const MIGRATION_ADVISORY_LOCK = 471114723;

export interface MigrateOutcome {
  ran: boolean;
  applied: number;
  skipped: number;
  ok: boolean;
  current?: boolean;
  error?: string;
}

/** Lock-free check: are all shipped migrations recorded in the ledger? */
async function isSchemaCurrent(): Promise<boolean> {
  try {
    const pool = getPool();
    const last = MIGRATIONS[MIGRATIONS.length - 1]?.name;
    if (!last) return true;
    const { rows } = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${LEDGER_TABLE} WHERE name = $1) AS present`,
      [last],
    );
    return rows[0]?.present === true;
  } catch {
    return false; // ledger missing / unreachable → treat as behind
  }
}

async function applyPendingMigrations(): Promise<MigrateOutcome> {
  // Fast path: already current → no lock, no work.
  if (await isSchemaCurrent()) {
    return { ran: false, applied: 0, skipped: MIGRATIONS.length, ok: true, current: true };
  }

  let client;
  try {
    client = await getPool().connect();
  } catch (error) {
    return { ran: false, applied: 0, skipped: 0, ok: false, error: error instanceof Error ? error.message : "connect failed" };
  }
  try {
    // NON-blocking: if another instance is already migrating, don't wait.
    const { rows } = await client.query<{ got: boolean }>(`SELECT pg_try_advisory_lock($1) AS got`, [MIGRATION_ADVISORY_LOCK]);
    if (rows[0]?.got !== true) {
      return { ran: false, applied: 0, skipped: 0, ok: true, current: false };
    }
    try {
      const result = await runMigrations();
      console.log(`[auto-migrate] applied=${result.applied} skipped=${result.skipped}`);
      return { ran: true, applied: result.applied, skipped: result.skipped, ok: true, current: true };
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_ADVISORY_LOCK]).catch(() => {});
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error("[auto-migrate] migrations did not complete:", message);
    return { ran: false, applied: 0, skipped: 0, ok: false, error: message };
  } finally {
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
 * Explicit, idempotent "make the schema current" trigger. Memoised per process
 * and cheap when the schema is already current. Reached from the schema health
 * check.
 */
export function ensureMigrationsApplied(): Promise<MigrateOutcome> {
  if (!ensured) ensured = applyPendingMigrations();
  return ensured;
}
