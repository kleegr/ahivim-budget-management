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
 *      it, a startup contender polls the migration ledger for a bounded period.
 *      It may continue only after the exact shipped schema is recorded; otherwise
 *      startup fails closed instead of serving code against an older schema.
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

const STARTUP_SCHEMA_WAIT_MS = 30_000;
const STARTUP_SCHEMA_POLL_MS = 250;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * A second cold start can lose the non-blocking advisory-lock race while the
 * first instance is applying the same release. Re-check the ledger rather than
 * blocking on that connection: a frozen lock holder cannot hold every startup
 * indefinitely, and no contender is allowed to serve an older schema.
 */
async function waitForCurrentSchema(): Promise<boolean> {
  const deadline = Date.now() + STARTUP_SCHEMA_WAIT_MS;
  while (Date.now() < deadline) {
    await wait(Math.min(STARTUP_SCHEMA_POLL_MS, Math.max(deadline - Date.now(), 1)));
    if (await isSchemaCurrent()) return true;
  }
  return false;
}

async function applyStartupMigrations(): Promise<void> {
  const outcome = await applyPendingMigrations();
  if (outcome.ok && outcome.current === true) return;

  if (outcome.ok && outcome.current === false) {
    if (await waitForCurrentSchema()) return;
    throw new Error(
      `Database schema did not become current within ${STARTUP_SCHEMA_WAIT_MS}ms while another process held the migration lock.`,
    );
  }

  throw new Error(`Database migrations failed; startup was stopped: ${outcome.error ?? "unknown error"}`);
}

async function verifyExternallyManagedSchema(): Promise<void> {
  if (await isSchemaCurrent()) return;
  throw new Error(
    "DISABLE_AUTO_MIGRATE=1 requires every shipped migration to be pre-applied; the database schema is not current.",
  );
}

let bootPromise: Promise<void> | null = null;

/**
 * Instrumentation-hook entry point. Honours DISABLE_AUTO_MIGRATE and shares one
 * result per process. A rejected result stays rejected so no later caller can
 * accidentally treat a failed startup migration as complete.
 */
export function runMigrationsOnce(): Promise<void> {
  if (!bootPromise) {
    bootPromise = process.env.DISABLE_AUTO_MIGRATE === "1"
      ? verifyExternallyManagedSchema()
      : applyStartupMigrations();
  }
  return bootPromise;
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
