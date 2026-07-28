import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasTestDatabase, testPool, resetSchema, closeTestPool } from "../support/database";
import { runMigrations, ledgerExists, listTables, tableCounts, LEDGER_TABLE } from "@/lib/db/migrate";

const suite = hasTestDatabase ? describe : describe.skip;

suite("migration runner (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
  }, 60_000);
  afterAll(closeTestPool);

  it("creates the ledger and every expected table", async () => {
    expect(await ledgerExists(testPool())).toBe(true);
    const tables = await listTables(testPool());
    expect(tables).toContain(LEDGER_TABLE);
    for (const table of [
      "users", "individuals", "employees", "programs", "program_aliases",
      "program_rate_schedules", "payroll_transactions", "service_sessions",
      "service_allocations", "rate_exceptions", "import_batches", "import_rows",
      "import_warnings", "imported_files", "audit_logs",
    ]) {
      expect(tables, `missing table ${table}`).toContain(table);
    }
    expect(tables.length).toBe(23);
  });

  it("is idempotent: a second run applies nothing and skips everything", async () => {
    const again = await runMigrations(testPool());
    expect(again.applied).toBe(0);
    expect(again.skipped).toBe(2);
    expect(again.outcomes.every((o) => o.status === "skipped")).toBe(true);
  });

  it("records one ledger row per migration file with a checksum", async () => {
    const { rows } = await testPool().query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM ${LEDGER_TABLE} ORDER BY name`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("0000_init.sql");
    expect(rows[1].name).toBe("0001_seed_programs_and_rates.sql");
    for (const row of rows) expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("seeds six programs, their aliases and effective-dated rates", async () => {
    const counts = await tableCounts(
      ["programs", "program_aliases", "program_rate_schedules"],
      testPool(),
    );
    expect(counts.programs).toBe(6);
    expect(counts.program_aliases).toBe(23);
    expect(counts.program_rate_schedules).toBe(6);
  });

  it("seeds the verified Com Hab and Respite rate ladder", async () => {
    const { rows } = await testPool().query<{
      code: string;
      agency_rate: string | null;
      internal_rate: string;
    }>(
      `SELECT p.code, s.agency_rate::text, s.internal_rate::text
       FROM programs p JOIN program_rate_schedules s ON s.program_id = p.id
       ORDER BY p.code`,
    );
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(Number(byCode.COM_HAB.agency_rate)).toBe(25);
    expect(Number(byCode.COM_HAB.internal_rate)).toBe(21);
    expect(Number(byCode.RESPITE.agency_rate)).toBe(19);
    expect(Number(byCode.RESPITE.internal_rate)).toBe(17);
    expect(byCode.SH_COM_HAB.agency_rate).toBeNull();
    expect(Number(byCode.SH_COM_HAB.internal_rate)).toBe(38);
    expect(Number(byCode.SH_RESPITE.internal_rate)).toBe(18);
  });

  it("detects a migration whose contents changed after it was applied", async () => {
    await testPool().query(
      `UPDATE ${LEDGER_TABLE} SET checksum = 'tampered' WHERE name = '0000_init.sql'`,
    );
    const result = await runMigrations(testPool());
    const outcome = result.outcomes.find((o) => o.name === "0000_init.sql");
    expect(outcome?.status).toBe("checksum_mismatch");
    expect(outcome?.error).toMatch(/already been applied/i);
    expect(result.applied).toBe(0);
    await resetSchema();
  }, 60_000);
});
