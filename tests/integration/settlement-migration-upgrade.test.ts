import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS } from "@/lib/db/migrations.generated";
import { migrationChecksum } from "@/lib/db/migration-checksum";
import { LEDGER_TABLE, runMigrations } from "@/lib/db/migrate";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import {
  closeTestPool,
  hasTestDatabase,
  testPool,
} from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const LEGACY_LAST_MIGRATION = "0016_financial_dashboard_fields.sql";

let pool: PgLikePool;
let employeeId: string;
let individualId: string;

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) =>
      statement
        .split("\n")
        .map((line) => line.trim())
        .some((line) => line.length > 0 && !line.startsWith("--")),
    );
}

async function buildLegacySchema(client: PgLikeClient): Promise<number> {
  const legacyLastIndex = MIGRATIONS.findIndex(
    (migration) => migration.name === LEGACY_LAST_MIGRATION,
  );
  if (legacyLastIndex < 0) throw new Error(`Missing ${LEGACY_LAST_MIGRATION}`);

  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
  await client.query(`
    CREATE TABLE ${LEDGER_TABLE} (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const migration of MIGRATIONS.slice(0, legacyLastIndex + 1)) {
    await client.query("BEGIN");
    try {
      for (const statement of splitStatements(migration.sql)) {
        await client.query(statement);
      }
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

  return legacyLastIndex + 1;
}

async function sourceVersion(): Promise<bigint> {
  const { rows } = await pool.query<{ source_version: string }>(
    `SELECT source_version::text FROM settlement_ledger_state WHERE singleton = true`,
  );
  return BigInt(rows[0]!.source_version);
}

async function expectSourceVersionAdvance(
  label: string,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  const before = await sourceVersion();
  await pool.query(sql, params);
  const after = await sourceVersion();
  expect(after, `${label} must invalidate settlement freshness`).toBeGreaterThan(before);
}

suite("settlement migrations from a populated 0016 database (real PostgreSQL)", () => {
  let legacyMigrationCount = 0;

  beforeAll(async () => {
    pool = testPool();
    const client = await pool.connect();
    try {
      legacyMigrationCount = await buildLegacySchema(client);
    } finally {
      client.release();
    }

    await pool.query(
      `INSERT INTO users
         (email, display_name, password_hash, role, access_scope,
          can_see_transactions, can_see_money)
       VALUES
         ('legacy-viewer@example.test', 'Legacy Viewer', 'x', 'viewer', 'scoped', true, false),
         ('legacy-manager@example.test', 'Legacy Manager', 'x', 'manager', 'full', true, true)`,
    );
    const employee = await pool.query<{ id: string }>(
      `INSERT INTO employees (normalized_name, display_name)
       VALUES ('legacy settlement employee', 'Legacy Settlement Employee')
       RETURNING id`,
    );
    const individual = await pool.query<{ id: string }>(
      `INSERT INTO individuals (normalized_name, display_name)
       VALUES ('legacy settlement individual', 'Legacy Settlement Individual')
       RETURNING id`,
    );
    employeeId = employee.rows[0]!.id;
    individualId = individual.rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, individual_id, check_number, check_date, payment_recipient,
          imported_amount, calculated_internal_amount, total_net_pay,
          transaction_fingerprint)
       VALUES ($1, $2, 'LEGACY-0016', '2026-08-15', 'employee',
               100, 90, 80, 'legacy-0016-settlement-source')`,
      [employeeId, individualId],
    );
  }, 60_000);

  afterAll(closeTestPool);

  it("applies only post-0016 migrations and preserves legacy rows and access", async () => {
    const result = await runMigrations(pool);
    const pendingMigrationCount = MIGRATIONS.length - legacyMigrationCount;

    expect(result.applied).toBe(pendingMigrationCount);
    expect(result.skipped).toBe(legacyMigrationCount);
    expect(result.outcomes).toHaveLength(MIGRATIONS.length);

    const { rows: users } = await pool.query<{
      email: string;
      can_see_hours: boolean;
      can_see_billed_amounts: boolean;
      can_see_employee_amounts: boolean;
      can_see_agency_spread: boolean;
      can_see_check_net: boolean;
      can_see_taxes: boolean;
      can_see_budgets: boolean;
      can_see_employee_deals: boolean;
      can_see_settlements: boolean;
    }>(
      `SELECT email, can_see_hours, can_see_billed_amounts,
              can_see_employee_amounts, can_see_agency_spread,
              can_see_check_net, can_see_taxes, can_see_budgets,
              can_see_employee_deals, can_see_settlements
         FROM users
        WHERE email LIKE 'legacy-%@example.test'
        ORDER BY email`,
    );
    expect(users).toEqual([
      {
        email: "legacy-manager@example.test",
        can_see_hours: true,
        can_see_billed_amounts: true,
        can_see_employee_amounts: true,
        can_see_agency_spread: true,
        can_see_check_net: true,
        can_see_taxes: true,
        can_see_budgets: true,
        can_see_employee_deals: true,
        can_see_settlements: true,
      },
      {
        email: "legacy-viewer@example.test",
        can_see_hours: true,
        can_see_billed_amounts: false,
        can_see_employee_amounts: false,
        can_see_agency_spread: false,
        can_see_check_net: false,
        can_see_taxes: false,
        can_see_budgets: true,
        can_see_employee_deals: false,
        can_see_settlements: false,
      },
    ]);

    const preserved = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM payroll_transactions
        WHERE transaction_fingerprint = 'legacy-0016-settlement-source'
          AND employee_id = $1
          AND individual_id = $2`,
      [employeeId, individualId],
    );
    expect(preserved.rows[0]!.count).toBe("1");

    const legacyCheck = await pool.query<{
      source: string;
      verification_status: string;
      actual_net: string;
      linked: boolean;
    }>(
      `SELECT check_fact.source, check_fact.verification_status,
              check_fact.actual_net::text,
              (t.payroll_check_id = check_fact.id) AS linked
         FROM payroll_transactions t
         JOIN employee_payroll_checks check_fact
           ON check_fact.id = t.payroll_check_id
        WHERE t.transaction_fingerprint = 'legacy-0016-settlement-source'`,
    );
    expect(legacyCheck.rows).toEqual([{
      source: "legacy_transaction",
      verification_status: "unverified",
      actual_net: "80.0000",
      linked: true,
    }]);

    const state = await pool.query<{
      source_version: string;
      refreshed_version: string;
    }>(
      `SELECT source_version::text, refreshed_version::text
         FROM settlement_ledger_state
        WHERE singleton = true`,
    );
    // 0019 creates the dirty legacy ledger at version 1. Migration 0030 then
    // deliberately advances it once because legacy transaction-level NET is no
    // longer settlement-authoritative after payroll-check facts are introduced.
    expect(state.rows[0]).toMatchObject({ source_version: "2", refreshed_version: "0" });
  }, 60_000);

  it("invalidates freshness for every mutable settlement source family", async () => {
    const program = await pool.query<{ id: string }>(
      `SELECT id FROM programs WHERE code = 'COM_HAB'`,
    );
    const programId = program.rows[0]!.id;
    const deal = await pool.query<{ id: string }>(
      `INSERT INTO employee_deals
         (employee_id, direct_rule, direct_percent, agency_cut_percent, effective_from)
       VALUES ($1, 'giveback_percent', 0.10, 0.20, '2026-01-01')
       RETURNING id`,
      [employeeId],
    );
    const strategy = await pool.query<{ id: string }>(
      `INSERT INTO calculation_strategies
         (individual_id, label, renewal_date, cut1_percent, cut2_percent)
       VALUES ($1, 'Upgrade trigger coverage', '2026-12-31', 0.10, 0.20)
       RETURNING id`,
      [individualId],
    );
    const line = await pool.query<{ id: string }>(
      `INSERT INTO calculation_strategy_lines
         (strategy_id, program_id, authorized_hours, rate_override)
       VALUES ($1, $2, 100, 21)
       RETURNING id`,
      [strategy.rows[0]!.id, programId],
    );
    const rate = await pool.query<{ id: string }>(
      `INSERT INTO program_rate_schedules
         (program_id, effective_from, agency_rate, internal_rate, notes)
       VALUES ($1, '2099-01-01', 26, 22, 'Settlement freshness test')
       RETURNING id`,
      [programId],
    );

    await expectSourceVersionAdvance(
      "employee deal update",
      `UPDATE employee_deals SET direct_percent = 0.15, updated_at = now() WHERE id = $1`,
      [deal.rows[0]!.id],
    );
    await expectSourceVersionAdvance(
      "strategy update",
      `UPDATE calculation_strategies SET cut1_percent = 0.12, updated_at = now() WHERE id = $1`,
      [strategy.rows[0]!.id],
    );
    await expectSourceVersionAdvance(
      "strategy line update",
      `UPDATE calculation_strategy_lines SET authorized_hours = 110, updated_at = now() WHERE id = $1`,
      [line.rows[0]!.id],
    );
    await expectSourceVersionAdvance(
      "rate schedule update",
      `UPDATE program_rate_schedules SET internal_rate = 23, updated_at = now() WHERE id = $1`,
      [rate.rows[0]!.id],
    );
    await expectSourceVersionAdvance(
      "payroll transaction update",
      `UPDATE payroll_transactions SET total_net_pay = 82, updated_at = now()
        WHERE transaction_fingerprint = 'legacy-0016-settlement-source'`,
    );
    await expectSourceVersionAdvance(
      "employee status update",
      `UPDATE employees SET status = 'archived', archived_at = now(), updated_at = now() WHERE id = $1`,
      [employeeId],
    );
    await expectSourceVersionAdvance(
      "individual status update",
      `UPDATE individuals SET status = 'archived', archived_at = now(), updated_at = now() WHERE id = $1`,
      [individualId],
    );
  }, 60_000);

  it("commits deferred settlement person checks on both trigger tables", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const obligation = await client.query<{ id: string }>(
        `INSERT INTO settlement_obligations
           (source_key, kind, direction, employee_id, original_amount,
            calculation_metadata)
         VALUES
           ('upgrade-trigger-check', 'employee_payout', 'payable', $1, 25,
            '{"flow":"agency_routed"}'::jsonb)
         RETURNING id`,
        [employeeId],
      );
      await client.query(
        `INSERT INTO settlement_events
           (settlement_obligation_id, employee_id, event_type, amount, occurred_on)
         VALUES ($1, $2, 'payment', 5, '2026-08-24')`,
        [obligation.rows[0]!.id, employeeId],
      );
      await client.query("COMMIT");

      const secondEmployee = await client.query<{ id: string }>(
        `INSERT INTO employees (normalized_name, display_name)
         VALUES ('upgrade trigger second employee', 'Upgrade Trigger Second Employee')
         RETURNING id`,
      );
      await client.query("BEGIN");
      await client.query(
        `UPDATE settlement_obligations
            SET employee_id = $2, updated_at = now()
          WHERE id = $1`,
        [obligation.rows[0]!.id, secondEmployee.rows[0]!.id],
      );
      await expect(client.query("COMMIT")).rejects.toThrow(/person must match at commit/i);
      await client.query("ROLLBACK").catch(() => undefined);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM settlement_obligations
        WHERE source_key = 'upgrade-trigger-check'`,
    );
    expect(rows[0]!.count).toBe("1");
  }, 60_000);
});
