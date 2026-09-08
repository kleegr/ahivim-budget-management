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
 *      a NON-blocking `pg_try_advisory_xact_lock` inside the migration transaction.
 *      If another instance already holds
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
  retryable?: boolean;
}

type SchemaCheck =
  | { status: "current" }
  | { status: "behind" }
  | { status: "unavailable"; diagnostic: string }
  | { status: "failed"; diagnostic: string };

const STARTUP_SCHEMA_CHECK_ATTEMPTS = 8;
const STARTUP_MIGRATION_ATTEMPTS = 4;
const STARTUP_RETRY_BASE_MS = 250;
const STARTUP_RETRY_MAX_MS = 2_000;
const STARTUP_SCHEMA_WAIT_MS = 30_000;
const STARTUP_SCHEMA_POLL_MS = 250;
const EXTERNAL_SCHEMA_CHECK_ATTEMPTS = STARTUP_SCHEMA_CHECK_ATTEMPTS;

/** A temporary database failure. Startup still fails closed, but a later call may retry. */
export class StartupDatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupDatabaseUnavailableError";
  }
}

function errorField(error: unknown, field: "code" | "message" | "name" | "type"): string | null {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
  try {
    const value = (error as Record<string, unknown>)[field];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  } catch {
    return null;
  }
}

function errorCause(error: unknown): unknown {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
  try {
    return (error as { cause?: unknown }).cause;
  } catch {
    return null;
  }
}

function errorConstructorName(error: unknown): string | null {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
  try {
    const name = error.constructor?.name;
    return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
  } catch {
    return null;
  }
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-database-url]")
    .replace(/\b(password|token|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 400);
}

/**
 * Database drivers occasionally reject with a WebSocket Event instead of an
 * Error. Keep diagnostics useful without stringifying the event (which is both
 * circular and liable to include connection details).
 */
function databaseErrorDiagnostic(error: unknown): string {
  if (typeof error === "string") return `type=string message=${redactDiagnostic(error)}`;

  const name = errorField(error, "name")
    ?? errorConstructorName(error)
    ?? (error === null ? "null" : typeof error);
  const code = errorField(error, "code");
  const message = error instanceof Error ? error.message : errorField(error, "message");
  const eventType = error instanceof Error ? null : errorField(error, "type");
  const parts = [`type=${redactDiagnostic(String(name))}`];
  if (code) parts.push(`code=${redactDiagnostic(code)}`);
  if (eventType) parts.push(`event=${redactDiagnostic(eventType)}`);
  if (message) parts.push(`message=${redactDiagnostic(message)}`);
  if (!code && !eventType && !message) parts.push("message=unavailable");
  return parts.join(" ");
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    chain.push(current);
    const cause = errorCause(current);
    if (cause == null || cause === current) break;
    current = cause;
  }
  return chain;
}

function isUndefinedTable(error: unknown): boolean {
  return errorChain(error).some((entry) => errorField(entry, "code") === "42P01");
}

function isTransientDatabaseError(error: unknown): boolean {
  for (const entry of errorChain(error)) {
    const code = errorField(entry, "code")?.toUpperCase() ?? "";
    if (
      code.startsWith("08")
      || [
        "40001", "40P01", "53300", "53400", "55006", "55P03",
        "57P01", "57P02", "57P03", "58000", "58030",
        "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
        "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
      ].includes(code)
    ) {
      return true;
    }

    const message = (
      typeof entry === "string"
        ? entry
        : entry instanceof Error
          ? entry.message
          : errorField(entry, "message") ?? ""
    ).toLowerCase();
    if (
      /connection (?:refused|reset|terminated|closed|lost)|failed to connect|connect (?:econn|etimedout)|database is waking|fetch failed|network|socket|timed? out|timeout|websocket|endpoint (?:is )?(?:disabled|suspended|unavailable)/
        .test(message)
    ) {
      return true;
    }

    const eventType = errorField(entry, "type")?.toLowerCase();
    if (!(entry instanceof Error) && (eventType === "error" || eventType === "close")) return true;
  }

  // Neon/WebSocket can reject with a non-Error Event-like object whose useful
  // fields are not enumerable. PostgreSQL statement failures are Error objects
  // with a SQLSTATE code, so an opaque non-Error is safe to treat as transient.
  if (typeof error === "string") return false;
  if (error instanceof Error) return false;
  if (error && (typeof error === "object" || typeof error === "function")) {
    const hasExplicitCode = errorChain(error).some((entry) => errorField(entry, "code") !== null);
    return !hasExplicitCode;
  }
  return false;
}

function retryDelay(attempt: number): number {
  return Math.min(STARTUP_RETRY_BASE_MS * (2 ** (attempt - 1)), STARTUP_RETRY_MAX_MS);
}

function logRetry(event: string, attempt: number, attempts: number, error: unknown): void {
  console.warn(JSON.stringify({
    event,
    attempt,
    attempts,
    diagnostic: typeof error === "string" && error.startsWith("type=")
      ? error
      : databaseErrorDiagnostic(error),
  }));
}

/**
 * Lock-free check: are all shipped migrations recorded with exact checksums?
 * Keep a transient connection failure distinct from a successfully read ledger
 * that is behind. Externally managed deployments may retry only the former.
 */
async function checkSchema(): Promise<SchemaCheck> {
  try {
    if (MIGRATIONS.length === 0) return { status: "current" };
    const pool = getPool();
    const expected = new Map(MIGRATIONS.map((migration) => [migration.name, migration.sql]));
    const { rows } = await pool.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM ${LEDGER_TABLE} WHERE name = ANY($1::text[])`,
      [[...expected.keys()]],
    );
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));
    for (const [name, sql] of expected) {
      const actual = applied.get(name);
      if (actual === undefined) return { status: "behind" };
      if (!migrationChecksumMatches(actual, sql)) throw new MigrationChecksumMismatchError(name);
    }
    return { status: "current" };
  } catch (error) {
    if (error instanceof MigrationChecksumMismatchError) throw error;
    // A brand-new database has no ledger yet and legitimately needs migration.
    if (isUndefinedTable(error)) return { status: "behind" };
    const diagnostic = databaseErrorDiagnostic(error);
    return isTransientDatabaseError(error)
      ? { status: "unavailable", diagnostic }
      : { status: "failed", diagnostic };
  }
}

async function checkStartupSchema(attempts = STARTUP_SCHEMA_CHECK_ATTEMPTS): Promise<SchemaCheck> {
  let last: SchemaCheck = { status: "unavailable", diagnostic: "type=unknown message=not-attempted" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await checkSchema();
    if (last.status !== "unavailable") {
      if (attempt > 1) {
        console.info(JSON.stringify({ event: "auto_migrate_schema_check_recovered", attempt, attempts }));
      }
      return last;
    }

    logRetry("auto_migrate_schema_check_retry", attempt, attempts, last.diagnostic);
    if (attempt < attempts) await wait(retryDelay(attempt));
  }
  return last;
}

async function runPendingMigrationsWithRetry(): Promise<MigrateOutcome> {
  for (let attempt = 1; attempt <= STARTUP_MIGRATION_ATTEMPTS; attempt += 1) {
    try {
      const result = await runMigrations(undefined, { waitForLock: false });
      console.info(JSON.stringify({
        event: "auto_migrate_complete",
        attempt,
        applied: result.applied,
        skipped: result.skipped,
      }));
      return { ran: true, applied: result.applied, skipped: result.skipped, ok: true, current: true };
    } catch (error) {
      if (error instanceof MigrationLockUnavailableError) {
        return { ran: false, applied: 0, skipped: 0, ok: true, current: false, retryable: true };
      }

      const retryable = isTransientDatabaseError(error);
      if (retryable && attempt < STARTUP_MIGRATION_ATTEMPTS) {
        logRetry("auto_migrate_apply_retry", attempt, STARTUP_MIGRATION_ATTEMPTS, error);
        await wait(retryDelay(attempt));
        continue;
      }

      const diagnostic = databaseErrorDiagnostic(error);
      console.error(JSON.stringify({
        event: "auto_migrate_apply_failed",
        attempt,
        attempts: STARTUP_MIGRATION_ATTEMPTS,
        retryable,
        diagnostic,
      }));
      return { ran: false, applied: 0, skipped: 0, ok: false, error: diagnostic, retryable };
    }
  }

  return {
    ran: false,
    applied: 0,
    skipped: 0,
    ok: false,
    retryable: true,
    error: "type=unknown message=migration-retry-loop-exhausted",
  };
}

async function applyPendingMigrations(): Promise<MigrateOutcome> {
  // Fast path: already current → no lock, no work. A temporary read failure is
  // retried and is never reinterpreted as proof that a migration is pending.
  const schema = await checkStartupSchema();
  if (schema.status === "current") {
    return { ran: false, applied: 0, skipped: MIGRATIONS.length, ok: true, current: true };
  }

  if (schema.status === "failed") {
    console.error(JSON.stringify({
      event: "auto_migrate_schema_check_failed",
      retryable: false,
      diagnostic: schema.diagnostic,
    }));
    return {
      ran: false,
      applied: 0,
      skipped: 0,
      ok: false,
      retryable: false,
      error: `Database schema validation failed (${schema.diagnostic}).`,
    };
  }

  if (schema.status === "unavailable") {
    console.error(JSON.stringify({
      event: "auto_migrate_schema_check_failed",
      attempts: STARTUP_SCHEMA_CHECK_ATTEMPTS,
      diagnostic: schema.diagnostic,
    }));
    return {
      ran: false,
      applied: 0,
      skipped: 0,
      ok: false,
      retryable: true,
      error: `Database schema could not be verified after ${STARTUP_SCHEMA_CHECK_ATTEMPTS} attempts (${schema.diagnostic}).`,
    };
  }

  // Only a successfully read, confirmed-behind ledger may enter the mutating
  // runner. The runner owns the advisory-lock transaction, so checking and
  // applying migrations remain serialized without a nested lock.
  return runPendingMigrationsWithRetry();
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * A second cold start can lose the non-blocking advisory-lock race while the
 * first instance is applying the same release. Re-check the ledger rather than
 * blocking on that connection: a frozen lock holder cannot hold every startup
 * indefinitely, and no contender is allowed to serve an older schema.
 */
async function waitForCurrentSchema(): Promise<SchemaCheck> {
  const deadline = Date.now() + STARTUP_SCHEMA_WAIT_MS;
  let last: SchemaCheck = { status: "behind" };
  while (Date.now() < deadline) {
    await wait(Math.min(STARTUP_SCHEMA_POLL_MS, Math.max(deadline - Date.now(), 1)));
    last = await checkSchema();
    if (last.status === "current" || last.status === "failed") return last;
  }
  return last;
}

async function applyStartupMigrations(): Promise<void> {
  const outcome = await applyPendingMigrations();
  if (outcome.ok && outcome.current === true) return;

  if (outcome.ok && outcome.current === false) {
    const waited = await waitForCurrentSchema();
    if (waited.status === "current") return;
    if (waited.status === "failed") {
      throw new Error(
        `Database schema validation failed while waiting for the migration lock: ${waited.diagnostic}`,
      );
    }
    throw new StartupDatabaseUnavailableError(
      `Database schema did not become current within ${STARTUP_SCHEMA_WAIT_MS}ms while another process held the migration lock.`,
    );
  }

  if (outcome.retryable) {
    throw new StartupDatabaseUnavailableError(
      `Database migrations could not be verified during a temporary database failure; startup was stopped: ${outcome.error ?? "unknown error"}`,
    );
  }

  throw new Error(`Database migrations failed; startup was stopped: ${outcome.error ?? "unknown error"}`);
}

async function verifyExternallyManagedSchema(): Promise<void> {
  for (let attempt = 1; attempt <= EXTERNAL_SCHEMA_CHECK_ATTEMPTS; attempt += 1) {
    const result = await checkSchema();
    if (result.status === "current") return;
    if (result.status === "behind") {
      throw new Error(
        "DISABLE_AUTO_MIGRATE=1 requires every shipped migration to be pre-applied; the database schema is not current.",
      );
    }
    if (result.status === "failed") {
      throw new Error(
        `DISABLE_AUTO_MIGRATE=1 schema validation failed; startup was stopped: ${result.diagnostic}`,
      );
    }
    logRetry("external_schema_check_retry", attempt, EXTERNAL_SCHEMA_CHECK_ATTEMPTS, result.diagnostic);
    if (attempt < EXTERNAL_SCHEMA_CHECK_ATTEMPTS) await wait(retryDelay(attempt));
  }

  throw new StartupDatabaseUnavailableError(
    `DISABLE_AUTO_MIGRATE=1 could not verify the database schema after ${EXTERNAL_SCHEMA_CHECK_ATTEMPTS} attempts; startup was stopped.`,
  );
}

let bootPromise: Promise<void> | null = null;

/**
 * Instrumentation-hook entry point. Honours DISABLE_AUTO_MIGRATE and shares one
 * in-flight/successful result per process. A deterministic migration safety
 * failure stays rejected. A bounded temporary-availability failure is cleared
 * only after it has failed closed, allowing a later invocation to retry rather
 * than permanently poisoning a warm serverless instance.
 */
export function runMigrationsOnce(): Promise<void> {
  if (!bootPromise) {
    const attempt = process.env.DISABLE_AUTO_MIGRATE === "1"
      ? verifyExternallyManagedSchema()
      : applyStartupMigrations();
    bootPromise = attempt.catch((error) => {
      if (error instanceof StartupDatabaseUnavailableError) bootPromise = null;
      throw error;
    });
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
  if (!ensured) {
    const attempt = applyPendingMigrations();
    ensured = attempt;
    void attempt.then(
      (outcome) => {
        if (!outcome.ok || outcome.current !== true) ensured = null;
      },
      () => {
        ensured = null;
      },
    );
  }
  return ensured;
}
