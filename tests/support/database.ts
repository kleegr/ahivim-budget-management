import { Pool } from "pg";
import type { PgLikePool } from "@/lib/import/commit";
import { runMigrations } from "@/lib/db/migrate";

/**
 * Integration-test database.
 *
 * These tests run the REAL SQL against a real PostgreSQL. When
 * TEST_DATABASE_URL is not set they are skipped rather than silently passing,
 * and the skip is visible in the vitest output.
 *
 *   createdb ahivim_test
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/ahivim_test npm test
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
export const hasTestDatabase = TEST_DATABASE_URL.trim() !== "";

let pool: Pool | null = null;

export function testPool(): PgLikePool {
  if (!pool) {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  }
  return pool as unknown as PgLikePool;
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Drop and rebuild the schema, then apply the real migration files. Every
 * integration suite starts from exactly what a fresh deployment would have.
 */
export async function resetSchema(): Promise<void> {
  const p = testPool();
  await p.query(`DROP SCHEMA IF EXISTS public CASCADE`);
  await p.query(`CREATE SCHEMA public`);
  await runMigrations(p);
}

/** Remove business data but keep the schema and the seeded reference data. */
export async function truncateBusinessTables(): Promise<void> {
  const p = testPool();
  await p.query(`
    TRUNCATE service_allocations, service_sessions, rate_exceptions,
             payroll_transactions, import_warnings, import_rows, import_batches,
             imported_files, budget_authorizations, budget_periods,
             account_adjustments, account_periods, account_configurations,
             individual_aliases, employee_aliases, individuals, employees,
             audit_logs, users
    RESTART IDENTITY CASCADE
  `);
}

export async function countRows(table: string): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
  const { rows } = await testPool().query<{ c: string }>(
    `SELECT count(*)::text AS c FROM "${table}"`,
  );
  return Number(rows[0]?.c ?? 0);
}
