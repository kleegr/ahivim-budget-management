import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS } from "@/lib/db/migrations.generated";
import { migrationChecksum } from "@/lib/db/migration-checksum";
import { LEDGER_TABLE, runMigrations } from "@/lib/db/migrate";
import type { PgLikeClient } from "@/lib/import/commit";
import { closeTestPool, hasTestDatabase, testPool } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const PRE_OWNERSHIP_MIGRATION = "0021_planner_access.sql";

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement
      .split("\n")
      .some((line) => line.trim().length > 0 && !line.trim().startsWith("--")));
}

async function buildPreOwnershipSchema(client: PgLikeClient): Promise<number> {
  const lastIndex = MIGRATIONS.findIndex((migration) => migration.name === PRE_OWNERSHIP_MIGRATION);
  if (lastIndex < 0) throw new Error(`Missing ${PRE_OWNERSHIP_MIGRATION}`);
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
  await client.query(`CREATE TABLE ${LEDGER_TABLE} (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const migration of MIGRATIONS.slice(0, lastIndex + 1)) {
    await client.query("BEGIN");
    try {
      for (const statement of splitStatements(migration.sql)) await client.query(statement);
      await client.query(
        `INSERT INTO ${LEDGER_TABLE} (name, checksum) VALUES ($1, $2)`,
        [migration.name, migrationChecksum(migration.sql)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
  return lastIndex + 1;
}

suite("schedule series ownership migration (real PostgreSQL)", () => {
  afterAll(closeTestPool);

  it("backfills each legacy series participant from materialized allocations", async () => {
    const pool = testPool();
    const client = await pool.connect();
    let existingMigrations: number;
    try {
      existingMigrations = await buildPreOwnershipSchema(client);
    } finally {
      client.release();
    }

    const employee = await pool.query<{ id: string }>(
      `INSERT INTO employees (normalized_name, display_name)
       VALUES ('legacy schedule employee', 'Legacy Schedule Employee') RETURNING id`,
    );
    const individual = await pool.query<{ id: string }>(
      `INSERT INTO individuals (normalized_name, display_name)
       VALUES ('legacy schedule individual', 'Legacy Schedule Individual') RETURNING id`,
    );
    const program = await pool.query<{ id: string }>(`SELECT id FROM programs WHERE code = 'DAY_HAB'`);
    const series = await pool.query<{ id: string }>(
      `INSERT INTO schedule_series
         (employee_id, program_id, frequency, weekdays, start_date, end_date,
          start_time, end_time, duration_hours)
       VALUES ($1, $2, 'weekly', '[1]'::jsonb, '2026-01-01', '2026-12-31', '09:00', '11:00', 2)
       RETURNING id`,
      [employee.rows[0].id, program.rows[0].id],
    );
    const session = await pool.query<{ id: string }>(
      `INSERT INTO scheduled_sessions
         (series_id, employee_id, program_id, session_date, start_time, end_time, duration_hours)
       VALUES ($1, $2, $3, '2026-01-05', '09:00', '11:00', 2) RETURNING id`,
      [series.rows[0].id, employee.rows[0].id, program.rows[0].id],
    );
    await pool.query(
      `INSERT INTO scheduled_allocations (scheduled_session_id, individual_id, allocation_hours)
       VALUES ($1, $2, 2), ($1, $2, 2)`,
      [session.rows[0].id, individual.rows[0].id],
    );

    const result = await runMigrations(pool);
    expect(result.skipped).toBe(existingMigrations);
    expect(result.applied).toBe(MIGRATIONS.length - existingMigrations);
    const owners = await pool.query<{ series_id: string; individual_id: string }>(
      `SELECT series_id::text, individual_id::text FROM schedule_series_individuals`,
    );
    expect(owners.rows).toEqual([{
      series_id: series.rows[0].id,
      individual_id: individual.rows[0].id,
    }]);
    const versionFields = await pool.query<{
      recurrence_anchor_date: string;
      supersedes_series_id: string | null;
    }>(
      `SELECT recurrence_anchor_date::text, supersedes_series_id
         FROM schedule_series WHERE id = $1`,
      [series.rows[0].id],
    );
    expect(versionFields.rows[0]).toEqual({
      recurrence_anchor_date: "2026-01-01",
      supersedes_series_id: null,
    });
    const repairedAllocations = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM scheduled_allocations
        WHERE scheduled_session_id = $1 AND individual_id = $2`,
      [session.rows[0].id, individual.rows[0].id],
    );
    expect(repairedAllocations.rows[0]?.count).toBe("1");
    await expect(pool.query(
      `INSERT INTO scheduled_allocations (scheduled_session_id, individual_id, allocation_hours)
       VALUES ($1, $2, 2)`,
      [session.rows[0].id, individual.rows[0].id],
    )).rejects.toMatchObject({
      code: "23505",
      constraint: "scheduled_allocations_one_individual_key",
    });

    const insertSuccessor = `INSERT INTO schedule_series
       (employee_id, program_id, service_type, frequency, interval, weekdays,
        recurrence_anchor_date, supersedes_series_id, start_date, end_date,
        start_time, end_time, duration_hours, status, notes)
     SELECT employee_id, program_id, service_type, frequency, interval, weekdays,
            recurrence_anchor_date, id, start_date, end_date,
            start_time, end_time, duration_hours, status, notes
       FROM schedule_series WHERE id = $1
     RETURNING id`;
    const successorAttempts = await Promise.allSettled([
      pool.query(insertSuccessor, [series.rows[0].id]),
      pool.query(insertSuccessor, [series.rows[0].id]),
    ]);
    expect(successorAttempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = successorAttempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(rejected?.reason).toMatchObject({
      code: "23505",
      constraint: "schedule_series_one_live_successor_key",
    });
  }, 60_000);
});
