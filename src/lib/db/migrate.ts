import { getPool } from "./index";
import { MIGRATIONS } from "./migrations.generated";
import { createHash } from "node:crypto";
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

export interface MigrationOutcome {
  name: string;
  status: "applied" | "skipped" | "checksum_mismatch";
  statements?: number;
  error?: string;
}

export interface MigrationRunResult {
  ledgerExistedBefore: boolean;
  outcomes: MigrationOutcome[];
  applied: number;
  skipped: number;
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
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)+$/.test(s));
}

export async function runMigrations(explicitPool?: MaybePool): Promise<MigrationRunResult> {
  const pool = resolve(explicitPool);
  const existedBefore = await ledgerExists(pool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows: applied } = await pool.query<{ name: string; checksum: string }>(
    `SELECT name, checksum FROM ${LEDGER_TABLE}`,
  );
  const appliedMap = new Map(applied.map((r) => [r.name, r.checksum]));

  const outcomes: MigrationOutcome[] = [];

  for (const migration of MIGRATIONS) {
    const checksum = createHash("sha256").update(migration.sql).digest("hex");
    const previous = appliedMap.get(migration.name);

    if (previous !== undefined) {
      outcomes.push({
        name: migration.name,
        status: previous === checksum ? "skipped" : "checksum_mismatch",
        error:
          previous === checksum
            ? undefined
            : "This migration has already been applied but its contents have changed. " +
              "Add a new migration instead of editing an applied one.",
      });
      continue;
    }

    const statements = splitStatements(migration.sql);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO ${LEDGER_TABLE} (name, checksum) VALUES ($1, $2)`,
        [migration.name, checksum],
      );
      await client.query("COMMIT");
      outcomes.push({ name: migration.name, status: "applied", statements: statements.length });
    } catch (error) {
      await client.query("ROLLBACK");
      // The message may name a column or constraint, never a connection string.
      throw new Error(
        `Migration ${migration.name} failed and was rolled back: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    } finally {
      client.release();
    }
  }

  return {
    ledgerExistedBefore: existedBefore,
    outcomes,
    applied: outcomes.filter((o) => o.status === "applied").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
  };
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
