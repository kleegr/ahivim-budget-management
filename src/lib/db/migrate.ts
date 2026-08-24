import { getPool } from "./index";
import { MIGRATIONS } from "./migrations.generated";
import { migrationChecksum, migrationChecksumMatches } from "./migration-checksum";
import type { PgLikePool } from "@/lib/import/commit";

/**
 * Every entry point accepts an explicit pool so the migration runner can be
 * exercised against a real throwaway PostgreSQL in the integration tests
 * rather than only against the deployed Neon database.
 */
type MaybePool = PgLikePool | undefined;
const resolve = (pool: MaybePool): PgLikePool => pool ?? (getPool() as unknown as PgLikePool);

/**
 * A small, explicit migration runner.
 *
 * Each file runs once, inside its own transaction, and is recorded in
 * `_ahivim_migrations`. Re-running is safe: applied migrations are skipped.
 * A checksum is stored so an edited-after-the-fact migration is detected
 * rather than silently ignored.
 */

export const LEDGER_TABLE = "_ahivim_migrations";
export const MIGRATION_ADVISORY_LOCK = 471114723;

export class MigrationLockUnavailableError extends Error {
  constructor() {
    super("Another process is applying database migrations.");
    this.name = "MigrationLockUnavailableError";
  }
}

export interface MigrationOutcome {
  name: string;
  status: "applied" | "skipped";
  statements?: number;
  error?: string;
}

export interface MigrationRunResult {
  ledgerExistedBefore: boolean;
  outcomes: MigrationOutcome[];
  applied: number;
  skipped: number;
}

export interface RunMigrationsOptions {
  /** Auto-migrate uses a non-blocking attempt; operator-triggered runs wait. */
  waitForLock?: boolean;
}

export async function ledgerExists(explicitPool?: MaybePool): Promise<boolean> {
  const pool = resolve(explicitPool);
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1
     ) AS exists`,
    [LEDGER_TABLE],
  );
  return rows[0]?.exists === true;
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => {
      if (s.length === 0) return false;
      // Keep a chunk only if it contains at least one real (non-comment) line.
      // Done line-by-line — a regex like /^(--[^\n]*\n?)+$/ backtracks
      // catastrophically on a long comment header and can hang the runner.
      return s
        .split("\n")
        .map((line) => line.trim())
        .some((line) => line.length > 0 && !line.startsWith("--"));
    });
}

export async function runMigrations(
  explicitPool?: MaybePool,
  options: RunMigrationsOptions = {},
): Promise<MigrationRunResult> {
  const pool = resolve(explicitPool);
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    if (options.waitForLock === false) {
      const { rows } = await client.query<{ got: boolean }>(
        `SELECT pg_try_advisory_lock($1) AS got`,
        [MIGRATION_ADVISORY_LOCK],
      );
      if (rows[0]?.got !== true) throw new MigrationLockUnavailableError();
    } else {
      await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_ADVISORY_LOCK]);
    }
    lockAcquired = true;

    const { rows: ledgerRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = $1
       ) AS exists`,
      [LEDGER_TABLE],
    );
    const existedBefore = ledgerRows[0]?.exists === true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows: applied } = await client.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM ${LEDGER_TABLE}`,
    );
    const appliedMap = new Map(applied.map((row) => [row.name, row.checksum]));
    const outcomes: MigrationOutcome[] = [];

    for (const migration of MIGRATIONS) {
      const checksum = migrationChecksum(migration.sql);
      const previous = appliedMap.get(migration.name);

      if (previous !== undefined) {
        if (!migrationChecksumMatches(previous, migration.sql)) {
          throw new Error(
            `Migration ${migration.name} checksum mismatch. ` +
            "Add a new migration instead of editing an applied one.",
          );
        }
        outcomes.push({ name: migration.name, status: "skipped" });
        continue;
      }

      const statements = splitStatements(migration.sql);
      try {
        await client.query("BEGIN");
        for (const statement of statements) await client.query(statement);
        await client.query(
          `INSERT INTO ${LEDGER_TABLE} (name, checksum) VALUES ($1, $2)`,
          [migration.name, checksum],
        );
        await client.query("COMMIT");
        outcomes.push({ name: migration.name, status: "applied", statements: statements.length });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(
          `Migration ${migration.name} failed and was rolled back: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }

    return {
      ledgerExistedBefore: existedBefore,
      outcomes,
      applied: outcomes.filter((outcome) => outcome.status === "applied").length,
      skipped: outcomes.filter((outcome) => outcome.status === "skipped").length,
    };
  } finally {
    if (lockAcquired) {
      await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_ADVISORY_LOCK]).catch(() => undefined);
    }
    client.release();
  }
}

/** Table names present in the current schema, for the health report. */
export async function listTables(explicitPool?: MaybePool): Promise<string[]> {
  const { rows } = await resolve(explicitPool).query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

/** Row counts for the major tables, for the handoff report. */
export async function tableCounts(
  tables: string[],
  explicitPool?: MaybePool,
): Promise<Record<string, number>> {
  const pool = resolve(explicitPool);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    // Table names come from information_schema, not from user input.
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) continue;
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${table}"`,
    );
    counts[table] = Number(rows[0]?.count ?? 0);
  }
  return counts;
}
