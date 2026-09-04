import { getPool } from "./index";
import {
  runMigrations,
  LEDGER_TABLE,
  MigrationLockUnavailableError,
} from "./migrate";
import { MIGRATIONS } from "./migrations.generated";
import { migrationChecksumMatches } from "./migration-checksum";

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

export class MigrationChecksumMismatchError extends Error {
  constructor(name: string) {
    super(`Migration ${name} checksum mismatch. Add a new migration instead of editing an applied one.`);
    this.name = "MigrationChecksumMismatchError";
  }
}

export interface MigrateOutcome {
  ran: boolean;
  applied: number;
  skipped: number;
  ok: boolean;
  current?: boolean;
  error?: string;
}

/** Lock-free check: are all shipped migrations recorded with exact checksums? */
async function isSchemaCurrent(): Promise<boolean> {
  try {
    const pool = getPool();
    if (MIGRATIONS.length === 0) return true;
    const expected = new Map(MIGRATIONS.map((migration) => [migration.name, migration.sql]));
    const { rows } = await pool.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM ${LEDGER_TABLE} WHERE name = ANY($1::text[])`,
      [[...expected.keys()]],
    );
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));
    for (const [name, sql] of expected) {
      const actual = applied.get(name);
      if (actual === undefined) return false;
      if (!migrationChecksumMatches(actual, sql)) throw new MigrationChecksumMismatchError(name);
    }
    return true;
  } catch (error) {
    if (error instanceof MigrationChecksumMismatchError) throw error;
    return false; // ledger missing / unreachable → treat as behind
  }
}

async function applyPendingMigrations(): Promise<MigrateOutcome> {
  // Fast path: already current → no lock, no work.
  if (await isSchemaCurrent()) {
    return { ran: false, applied: 0, skipped: MIGRATIONS.length, ok: true, current: true };
  }

  try {
    // The runner owns the advisory-lock connection, so checking and applying
    // migrations are serialized as one operation without a nested lock.
    const result = await runMigrations(undefined, { waitForLock: false });
    console.log(`[auto-migrate] applied=${result.applied} skipped=${result.skipped}`);
    return { ran: true, applied: result.applied, skipped: result.skipped, ok: true, current: true };
  } catch (error) {
    if (error instanceof MigrationLockUnavailableError) {
      return { ran: false, applied: 0, skipped: 0, ok: true, current: false };
    }
    const message = error instanceof Error ? error.message : "unknown error";
    console.error("[auto-migrate] migrations did not complete:", message);
    return { ran: false, applied: 0, skipped: 0, ok: false, error: message };
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
 * and cheap when the schema is already current. Reached only from explicitly
 * authorized maintenance routes; public health checks remain read-only.
 */
export function ensureMigrationsApplied(): Promise<MigrateOutcome> {
  if (!ensured) ensured = applyPendingMigrations();
  return ensured;
}
