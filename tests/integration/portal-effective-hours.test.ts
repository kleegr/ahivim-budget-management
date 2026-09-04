import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PortalAccessContext } from "@/lib/auth/portal-access";
import { getPortalHomeReadModel } from "@/lib/data/portal-read-model";
import type { PgLikePool } from "@/lib/import/commit";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;

async function createPortalScope(code: string, name: string) {
  const pool = testPool();
  const date = await pool.query<{ today: string; month: string }>(
    `SELECT ((now() AT TIME ZONE 'America/New_York')::date)::text AS today,
            to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM') AS month`,
  );
  const agency = await pool.query<{ id: string }>(
    `INSERT INTO agencies (code, name) VALUES ($1, $2) RETURNING id`,
    [code, `${name} Agency`],
  );
  const individual = await pool.query<{ id: string }>(
    `INSERT INTO individuals (normalized_name, display_name)
     VALUES ($1, $2) RETURNING id`,
    [name.toLowerCase(), name],
  );
  await pool.query(
    `INSERT INTO agency_individuals
       (agency_id, individual_id, manages_budget, bills_services, effective_from)
     VALUES ($1, $2, true, true, '2020-01-01')`,
    [agency.rows[0]!.id, individual.rows[0]!.id],
  );

  const context: PortalAccessContext = {
    userId: `user:${code}`,
    globalRoles: [{ role: "parent", grants: [], denials: [] }],
    individualLinks: [{
      individualId: individual.rows[0]!.id,
      relationship: "guardian",
      grants: [],
      denials: [],
    }],
    employeeLinks: [],
    agencyAccess: [{
      agencyId: agency.rows[0]!.id,
      agencyCode: code,
      agencyName: `${name} Agency`,
      role: "scheduler",
      grants: [],
      denials: [],
    }],
  };

  return {
    pool,
    today: date.rows[0]!.today,
    month: date.rows[0]!.month,
    agencyId: agency.rows[0]!.id,
    individualId: individual.rows[0]!.id,
    context,
  };
}

async function programId(pool: PgLikePool, code: string): Promise<string> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM programs WHERE code = $1`, [code]);
  return result.rows[0]!.id;
}

async function addStrategyBudget(
  pool: PgLikePool,
  input: {
    individualId: string;
    programId: string;
    label: string;
    renewalDate: string;
    authorizedHours: number;
  },
): Promise<void> {
  const strategy = await pool.query<{ id: string }>(
    `INSERT INTO calculation_strategies (individual_id, label, renewal_date)
     VALUES ($1, $2, $3::date) RETURNING id`,
    [input.individualId, input.label, input.renewalDate],
  );
  await pool.query(
    `INSERT INTO calculation_strategy_lines (strategy_id, program_id, authorized_hours)
     VALUES ($1, $2, $3)`,
    [strategy.rows[0]!.id, input.programId, input.authorizedHours],
  );
}

function expectHourSurfaces(
  model: Awaited<ReturnType<typeof getPortalHomeReadModel>>,
  agencyId: string,
  expected: { authorized: string; used: string; remaining: string },
): void {
  const agency = model.agencies.find((entry) => entry.id === agencyId);
  expect(model.individuals[0]?.hours).toEqual(expected);
  expect(agency?.budgetHours).toEqual(expected);
  expect(agency?.individuals?.[0]?.hours).toEqual(expected);
}

suite("portal effective hours (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
  }, 60_000);

  afterAll(closeTestPool);

  it("includes a calculation-strategy budget and its billed usage on all portal hour surfaces", async () => {
    const scope = await createPortalScope("PORTAL_HOURS", "Portal Hours Person");
    const program = await programId(scope.pool, "COM_HAB");
    await addStrategyBudget(scope.pool, {
      individualId: scope.individualId,
      programId: program,
      label: "Portal strategy",
      renewalDate: "2020-10-01",
      authorizedHours: 100,
    });
    await scope.pool.query(
      `INSERT INTO payroll_transactions
         (individual_id, program_id, period_begin, period_end, imported_hours,
          imported_amount, transaction_fingerprint)
       VALUES ($1, $2, $3::date, $3::date, 25, 500, 'portal-effective-hours')`,
      [scope.individualId, program, scope.today],
    );

    const model = await getPortalHomeReadModel(scope.pool, scope.context, scope.month);
    expectHourSurfaces(model, scope.agencyId, {
      authorized: "100.0000",
      used: "25.0000",
      remaining: "75.0000",
    });
  }, 60_000);

  it("counts one transaction once and selects the primary overlapping strategy for the same program", async () => {
    const scope = await createPortalScope("PORTAL_OVERLAP", "Portal Overlap Person");
    const program = await programId(scope.pool, "COM_HAB");
    await addStrategyBudget(scope.pool, {
      individualId: scope.individualId,
      programId: program,
      label: "Overlap A",
      renewalDate: "2020-10-01",
      authorizedHours: 40,
    });
    await addStrategyBudget(scope.pool, {
      individualId: scope.individualId,
      programId: program,
      label: "Overlap B",
      renewalDate: "2020-11-01",
      authorizedHours: 60,
    });
    await scope.pool.query(
      `INSERT INTO payroll_transactions
         (individual_id, program_id, period_begin, period_end, imported_hours,
          imported_amount, transaction_fingerprint)
       VALUES ($1, $2, $3::date, $3::date, 10, 200, 'portal-overlapping-hours')`,
      [scope.individualId, program, scope.today],
    );
    const outsider = await scope.pool.query<{ id: string }>(
      `INSERT INTO individuals (normalized_name, display_name)
       VALUES ('portal unauthorized outsider', 'Portal Unauthorized Outsider') RETURNING id`,
    );
    await addStrategyBudget(scope.pool, {
      individualId: outsider.rows[0]!.id,
      programId: program,
      label: "Unauthorized budget",
      renewalDate: "2020-10-01",
      authorizedHours: 900,
    });
    await scope.pool.query(
      `INSERT INTO payroll_transactions
         (individual_id, program_id, period_begin, period_end, imported_hours,
          imported_amount, transaction_fingerprint)
       VALUES ($1, $2, $3::date, $3::date, 888, 17760, 'portal-unauthorized-hours')`,
      [outsider.rows[0]!.id, program, scope.today],
    );

    const model = await getPortalHomeReadModel(scope.pool, scope.context, scope.month);
    expectHourSurfaces(model, scope.agencyId, {
      authorized: "40.0000",
      used: "10.0000",
      remaining: "30.0000",
    });
    expect(JSON.stringify(model)).not.toContain("Portal Unauthorized Outsider");
  }, 60_000);

  it("prefers a physical balance and preserves its payroll plus event usage over a strategy", async () => {
    const scope = await createPortalScope("PORTAL_PHYSICAL", "Portal Physical Person");
    const program = await programId(scope.pool, "COM_HAB");
    await addStrategyBudget(scope.pool, {
      individualId: scope.individualId,
      programId: program,
      label: "Shadowing strategy",
      renewalDate: "2020-10-01",
      authorizedHours: 100,
    });
    const period = await scope.pool.query<{ id: string }>(
      `INSERT INTO budget_periods
         (individual_id, label, start_date, end_date, period_type, status)
       VALUES
         ($1, 'Current physical period', ($2::date - interval '1 year')::date,
          ($2::date + interval '1 year')::date, 'custom', 'active')
       RETURNING id`,
      [scope.individualId, scope.today],
    );
    await scope.pool.query(
      `INSERT INTO budget_authorizations
         (budget_period_id, individual_id, program_id, authorized_hours, internal_rate, status)
       VALUES ($1, $2, $3, 80, 20, 'active')`,
      [period.rows[0]!.id, scope.individualId, program],
    );
    await scope.pool.query(
      `INSERT INTO payroll_transactions
         (individual_id, program_id, period_begin, period_end, imported_hours,
          imported_amount, transaction_fingerprint)
       VALUES ($1, $2, $3::date, $3::date, 10, 200, 'portal-physical-payroll')`,
      [scope.individualId, program, scope.today],
    );
    await scope.pool.query(
      `INSERT INTO program_budget_events
         (budget_period_id, individual_id, program_id, event_type, service_date,
          hours, amount, source_type, source_id)
       VALUES ($1, $2, $3, 'adjust', $4::date, 3, 0, 'portal_test',
               'portal-physical-adjustment')`,
      [period.rows[0]!.id, scope.individualId, program, scope.today],
    );

    const effective = await scope.pool.query<{ source: string }>(
      `SELECT source
         FROM effective_budget_authorizations_at($1::date)
        WHERE individual_id = $2 AND program_id = $3`,
      [scope.today, scope.individualId, program],
    );
    expect(effective.rows).toEqual([{ source: "explicit_authorization" }]);

    const model = await getPortalHomeReadModel(scope.pool, scope.context, scope.month);
    expectHourSurfaces(model, scope.agencyId, {
      authorized: "80.0000",
      used: "13.0000",
      remaining: "67.0000",
    });
  }, 60_000);

  it("does not consume stray payroll for an invoice-backed synthetic budget", async () => {
    const scope = await createPortalScope("PORTAL_INVOICE", "Portal Invoice Person");
    const program = await scope.pool.query<{ id: string }>(
      `INSERT INTO programs (code, name, required_auth_type, consumption_source, rate_scope)
       VALUES ('PORTAL_INVOICE_PROGRAM', 'Portal invoice program', 'hours', 'invoice', 'flat')
       RETURNING id`,
    );
    await addStrategyBudget(scope.pool, {
      individualId: scope.individualId,
      programId: program.rows[0]!.id,
      label: "Invoice strategy",
      renewalDate: "2020-10-01",
      authorizedHours: 50,
    });
    await scope.pool.query(
      `INSERT INTO payroll_transactions
         (individual_id, program_id, period_begin, period_end, imported_hours,
          imported_amount, transaction_fingerprint)
       VALUES ($1, $2, $3::date, $3::date, 9, 180, 'portal-stray-invoice-payroll')`,
      [scope.individualId, program.rows[0]!.id, scope.today],
    );

    const model = await getPortalHomeReadModel(scope.pool, scope.context, scope.month);
    expectHourSurfaces(model, scope.agencyId, {
      authorized: "50.0000",
      used: "0.0000",
      remaining: "50.0000",
    });
  }, 60_000);

  it("uses a custom program's per-group rate and canonical service date", async () => {
    const scope = await createPortalScope("PORTAL_CUSTOM_GROUP", "Portal Custom Group Person");
    const program = await scope.pool.query<{ id: string }>(
      `INSERT INTO programs
         (code, name, is_group_capable, one_to_one_required, groups_allowed,
          allow_multiple_individuals, required_auth_type, consumption_source, rate_scope)
       VALUES
         ('CUSTOM_PORTAL_GROUP', 'Custom portal group', true, false, true,
          true, 'hours', 'payroll', 'per_group')
       RETURNING id`,
    );
    await scope.pool.query(
      `INSERT INTO program_rate_schedules (program_id, effective_from, internal_rate)
       VALUES ($1, '2020-01-01', 20)`,
      [program.rows[0]!.id],
    );
    await addStrategyBudget(scope.pool, {
      individualId: scope.individualId,
      programId: program.rows[0]!.id,
      label: "Custom group strategy",
      renewalDate: "2020-10-01",
      authorizedHours: 100,
    });
    await scope.pool.query(
      `INSERT INTO payroll_transactions
         (individual_id, program_id, check_date, period_end, imported_hours,
          imported_amount, calculated_internal_amount, internal_rate_applied,
          transaction_fingerprint, is_group_service)
       VALUES ($1, $2, $3::date, ($3::date + interval '2 years')::date,
               999, 220, 200, 20,
               'portal-custom-group-hours', true)`,
      [scope.individualId, program.rows[0]!.id, scope.today],
    );

    const model = await getPortalHomeReadModel(scope.pool, scope.context, scope.month);
    expectHourSurfaces(model, scope.agencyId, {
      authorized: "100.0000",
      used: "10.0000",
      remaining: "90.0000",
    });
  }, 60_000);
});
