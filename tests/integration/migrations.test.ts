import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hasTestDatabase, testPool, resetSchema, closeTestPool } from "../support/database";
import { runMigrations, ledgerExists, listTables, tableCounts, LEDGER_TABLE } from "@/lib/db/migrate";

const suite = hasTestDatabase ? describe : describe.skip;

suite("migration runner (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
  }, 60_000);
  afterAll(closeTestPool);

  it("serializes concurrent runners without applying a migration twice", async () => {
    const pool = testPool();
    await pool.query(`DROP SCHEMA IF EXISTS public CASCADE`);
    await pool.query(`CREATE SCHEMA public`);

    const results = await Promise.all([runMigrations(pool), runMigrations(pool)]);
    expect(results.map((result) => result.applied).sort((a, b) => a - b)).toEqual([0, 41]);
    expect(results.map((result) => result.skipped).sort((a, b) => a - b)).toEqual([0, 41]);
  }, 60_000);

  it("creates the ledger and every expected table", async () => {
    expect(await ledgerExists(testPool())).toBe(true);
    const tables = await listTables(testPool());
    expect(tables).toContain(LEDGER_TABLE);
    for (const table of [
      "users", "individuals", "employees", "programs", "program_aliases",
      "program_rate_schedules", "payroll_transactions", "service_sessions",
      "service_allocations", "rate_exceptions", "import_batches", "import_rows",
      "import_warnings", "imported_files", "audit_logs", "assignments",
      "schedule_series", "schedule_series_individuals", "scheduled_sessions", "scheduled_allocations",
      "budget_calculations", "app_settings",
      "calculation_strategies", "calculation_strategy_lines", "calculation_strategy_revisions",
      "individual_match_reviews",
      "sheet_sync_runs", "sheet_sync_rows", "sheet_sync_conflicts",
      "user_individual_access", "user_employee_access",
      "employee_deals", "employee_deal_revisions",
      "settlement_obligations", "settlement_obligation_transactions",
      "settlement_batches", "settlement_events", "settlement_ledger_state",
      "class_activities", "class_budget_periods", "class_invoices",
      "class_invoice_lines", "class_budget_ledger", "class_reimbursement_profiles",
      "class_cover_sheet_snapshots",
      "program_budget_events",
      "individual_program_revenue_terms", "employee_individual_compensation_terms",
      "agency_manual_income_entries",
      "agencies", "user_portal_roles", "user_agency_access",
      "user_individual_relationships", "user_employee_relationships",
      "agency_individuals", "agency_employees",
      "employee_payroll_checks", "employee_direct_pay_targets",
      "employee_weekly_availability", "employee_unavailability",
      "documents", "document_blobs", "document_versions", "document_drafts",
      "document_upload_intents",
    ]) {
      expect(tables, `missing table ${table}`).toContain(table);
    }
    expect(tables.length).toBe(73);
  });

  it("is idempotent: a second run applies nothing and skips everything", async () => {
    const again = await runMigrations(testPool());
    expect(again.applied).toBe(0);
    expect(again.skipped).toBe(41);
    expect(again.outcomes.every((o) => o.status === "skipped")).toBe(true);
  });

  it("records one ledger row per migration file with a checksum", async () => {
    const { rows } = await testPool().query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM ${LEDGER_TABLE} ORDER BY name`,
    );
    expect(rows).toHaveLength(41);
    expect(rows[0].name).toBe("0000_init.sql");
    expect(rows[1].name).toBe("0001_seed_programs_and_rates.sql");
    expect(rows[2].name).toBe("0002_editable_operations.sql");
    expect(rows[3].name).toBe("0003_scheduling.sql");
    expect(rows[4].name).toBe("0004_corrections_reconciliation.sql");
    expect(rows[5].name).toBe("0005_calculation_program_rules.sql");
    expect(rows[6].name).toBe("0006_calculation_strategies.sql");
    expect(rows[7].name).toBe("0007_seed_calculation_strategies.sql");
    expect(rows[8].name).toBe("0008_individual_matching.sql");
    expect(rows[9].name).toBe("0009_perf_indexes.sql");
    expect(rows[10].name).toBe("0010_strategy_rate_overrides.sql");
    expect(rows[11].name).toBe("0011_sheet_sync.sql");
    expect(rows[12].name).toBe("0012_effective_dated_overrides.sql");
    expect(rows[13].name).toBe("0013_transaction_paid.sql");
    expect(rows[14].name).toBe("0014_user_access_scope.sql");
    expect(rows[15].name).toBe("0015_user_hours_only.sql");
    expect(rows[16].name).toBe("0016_financial_dashboard_fields.sql");
    expect(rows[17].name).toBe("0017_deals_and_settlements.sql");
    expect(rows[18].name).toBe("0018_granular_visibility.sql");
    expect(rows[19].name).toBe("0019_settlement_freshness.sql");
    expect(rows[20].name).toBe("0020_settlement_trigger_fix.sql");
    expect(rows[21].name).toBe("0021_planner_access.sql");
    expect(rows[22].name).toBe("0022_schedule_series_individuals.sql");
    expect(rows[23].name).toBe("0023_schedule_series_versioning.sql");
    expect(rows[24].name).toBe("0024_effective_budget_authorizations.sql");
    expect(rows[25].name).toBe("0025_class_revenue_invoicing.sql");
    expect(rows[26].name).toBe("0026_document_editor_access.sql");
    expect(rows[27].name).toBe("0027_class_reimbursement_profiles.sql");
    expect(rows[28].name).toBe("0028_service_program_budgets.sql");
    expect(rows[29].name).toBe("0029_agencies_portal_access.sql");
    expect(rows[30].name).toBe("0030_direct_pay_targets_and_payroll_checks.sql");
    expect(rows[31].name).toBe("0031_settlement_manage_permission.sql");
    expect(rows[32].name).toBe("0032_enforce_sequential_calculations.sql");
    expect(rows[33].name).toBe("0033_home_agency_budget_responsibility.sql");
    expect(rows[34].name).toBe("0034_document_library.sql");
    expect(rows[35].name).toBe("0035_employee_availability.sql");
    expect(rows[36].name).toBe("0036_agency_financial_actuals.sql");
    expect(rows[37].name).toBe("0037_current_authorization_truth.sql");
    expect(rows[38].name).toBe("0038_unique_schedule_transaction_match.sql");
    expect(rows[39].name).toBe("0039_agency_roster_only.sql");
    expect(rows[40].name).toBe("0040_user_account_preset.sql");
    for (const row of rows) expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("supports roster-only agency memberships and constrained account presets", async () => {
    const purposeConstraint = await testPool().query<{ constraint_name: string }>(
      `SELECT constraint_name
         FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'agency_individuals'
          AND constraint_name = 'agency_individuals_purpose_check'`,
    );
    expect(purposeConstraint.rows).toHaveLength(0);

    const presetColumn = await testPool().query<{
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'account_preset'`,
    );
    expect(presetColumn.rows).toEqual([{ data_type: "text", is_nullable: "YES" }]);

    const presetConstraint = await testPool().query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND conname = 'users_account_preset_check'`,
    );
    expect(presetConstraint.rows).toHaveLength(1);
    expect(presetConstraint.rows[0]!.definition).toContain("custom_access");
    await expect(testPool().query(
      `INSERT INTO users (email, display_name, password_hash, role, account_preset)
       VALUES ('invalid-preset@example.test', 'Invalid preset', 'not-a-real-hash', 'viewer', 'not_a_preset')`,
    )).rejects.toThrow(/users_account_preset_check/i);
  });

  it("enforces one planned visit per recorded transaction at the database boundary", async () => {
    const { rows } = await testPool().query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'scheduled_sessions_one_transaction_match_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("CREATE UNIQUE INDEX");
    expect(rows[0]!.indexdef).toContain("WHERE (matched_transaction_id IS NOT NULL)");
  });

  it("seeds the service catalog, aliases and effective-dated rates", async () => {
    const counts = await tableCounts(
      ["programs", "program_aliases", "program_rate_schedules"],
      testPool(),
    );
    expect(counts.programs).toBe(7);
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

  it("installs canonical payment routing and universal authorization overlap guards", async () => {
    const routing = await testPool().query<{
      explicit_employee: string;
      explicit_agency: string;
      fallback_employee: string;
      fallback_agency: string;
      unsupported: string;
      volatility: string;
      period_begin_date: string;
      check_date: string;
      period_end_date: string;
      no_date: string | null;
      service_date_volatility: string;
    }>(
      `SELECT effective_payment_recipient('employee', 'agency') AS explicit_employee,
              effective_payment_recipient('excellent_staffing', 'employee') AS explicit_agency,
              effective_payment_recipient(NULL, 'employee') AS fallback_employee,
              effective_payment_recipient('unknown', 'agency') AS fallback_agency,
              effective_payment_recipient('other', 'agency') AS unsupported,
              (SELECT provolatile::text FROM pg_proc WHERE oid = 'effective_payment_recipient(text,text)'::regprocedure) AS volatility,
              canonical_service_date('2026-01-01', '2026-01-15', '2026-01-31')::text AS period_begin_date,
              canonical_service_date(NULL, '2026-01-15', '2026-01-31')::text AS check_date,
              canonical_service_date(NULL, NULL, '2026-01-31')::text AS period_end_date,
              canonical_service_date(NULL, NULL, NULL)::text AS no_date,
              (SELECT provolatile::text FROM pg_proc WHERE oid = 'canonical_service_date(date,date,date)'::regprocedure) AS service_date_volatility`,
    );
    expect(routing.rows[0]).toEqual({
      explicit_employee: "employee",
      explicit_agency: "excellent_staffing",
      fallback_employee: "employee",
      fallback_agency: "excellent_staffing",
      unsupported: "unknown",
      volatility: "i",
      period_begin_date: "2026-01-01",
      check_date: "2026-01-15",
      period_end_date: "2026-01-31",
      no_date: null,
      service_date_volatility: "i",
    });
    const budgetHelper = await testPool().query<{ definition: string }>(
      `SELECT pg_get_functiondef('effective_billed_hours(uuid,uuid,date,date,numeric)'::regprocedure) AS definition`,
    );
    expect(budgetHelper.rows[0]?.definition).toContain(
      "canonical_service_date(t.period_begin, t.check_date, t.period_end)",
    );
    const triggers = await testPool().query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname IN ('budget_authorizations_non_overlap_guard', 'budget_periods_non_overlap_guard')
        ORDER BY tgname`,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "budget_authorizations_non_overlap_guard",
      "budget_periods_non_overlap_guard",
    ]);

    const seeded = await testPool().query<{
      individual_id: string;
      program_id: string;
      first_period_id: string;
      second_period_id: string;
    }>(
      `WITH person AS (
         INSERT INTO individuals (display_name, normalized_name)
         VALUES ('Migration overlap guard', 'migration overlap guard')
         RETURNING id
       ), program AS (
         SELECT id FROM programs WHERE code = 'COM_HAB'
       ), first_period AS (
         INSERT INTO budget_periods (individual_id, label, start_date, end_date, status)
         SELECT person.id, 'First', '2026-01-01', '2026-12-31', 'active' FROM person
         RETURNING id, individual_id
       ), second_period AS (
         INSERT INTO budget_periods (individual_id, label, start_date, end_date, status)
         SELECT person.id, 'Second', '2027-01-01', '2027-12-31', 'active' FROM person
         RETURNING id
       )
       SELECT person.id AS individual_id, program.id AS program_id,
              first_period.id AS first_period_id, second_period.id AS second_period_id
         FROM person, program, first_period, second_period`,
    );
    const ids = seeded.rows[0]!;
    await testPool().query(
      `INSERT INTO budget_authorizations
         (budget_period_id, individual_id, program_id, authorized_hours, internal_rate, status)
       VALUES ($1, $2, $3, 100, 21, 'active')`,
      [ids.first_period_id, ids.individual_id, ids.program_id],
    );
    await testPool().query(
      `INSERT INTO budget_authorizations
         (budget_period_id, individual_id, program_id, authorized_hours, internal_rate, status)
       VALUES ($1, $2, $3, 100, 21, 'active')`,
      [ids.second_period_id, ids.individual_id, ids.program_id],
    );
    await expect(testPool().query(
      `UPDATE budget_periods SET start_date = '2026-06-01' WHERE id = $1`,
      [ids.second_period_id],
    )).rejects.toThrow(/may not overlap/i);

    const overlappingPeriod = await testPool().query<{ id: string }>(
      `INSERT INTO budget_periods (individual_id, label, start_date, end_date, status)
       VALUES ($1, 'Overlapping', '2026-06-01', '2027-05-31', 'active') RETURNING id`,
      [ids.individual_id],
    );
    await expect(testPool().query(
      `INSERT INTO budget_authorizations
         (budget_period_id, individual_id, program_id, authorized_hours, internal_rate, status)
       VALUES ($1, $2, $3, 100, 21, 'active')`,
      [overlappingPeriod.rows[0]!.id, ids.individual_id, ids.program_id],
    )).rejects.toThrow(/may not overlap/i);
  });

  it("detects a migration whose contents changed after it was applied", async () => {
    await testPool().query(
      `UPDATE ${LEDGER_TABLE} SET checksum = 'tampered' WHERE name = '0000_init.sql'`,
    );
    await expect(runMigrations(testPool())).rejects.toThrow(/checksum mismatch/i);
    await resetSchema();
  }, 60_000);
});
