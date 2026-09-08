import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PortalAccessContext } from "@/lib/auth/portal-access";
import { getPortalHomeReadModel } from "@/lib/data/portal-read-model";
import { getIndividualBudgetView, getIndividualPeriodActivity, listIndividualBudgetBoard } from "@/lib/data/queries";
import { listCurrentProgramBudgets } from "@/lib/data/program-budgets";
import type { PgLikePool } from "@/lib/import/commit";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
let pool: PgLikePool;

suite("Developer 1 confirmed group credit across profiles and approved portals", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(truncateBusinessTables);
  afterAll(closeTestPool);

  it.each([false, true])("preserves full confirmed credits and privacy with physical authorization=%s", async (physical) => {
    const dates = (await pool.query<{ today: string; start: string; end: string }>(
      `SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS today,
              date_trunc('year', now() AT TIME ZONE 'America/New_York')::date::text AS start,
              (date_trunc('year', now() AT TIME ZONE 'America/New_York') + interval '1 year')::date::text AS end`,
    )).rows[0]!;
    const people = (await pool.query<{ id: string }>(
      `INSERT INTO individuals (normalized_name, display_name)
       VALUES ('group allowed example', 'Group allowed example'),
              ('group excluded example', 'Group excluded example') RETURNING id`,
    )).rows;
    const person = people[0]!.id;
    const outsider = people[1]!.id;
    const agency = (await pool.query<{ id: string }>(
      `INSERT INTO agencies (code, name) VALUES ($1, 'Group hours example agency') RETURNING id`, [`HOURS_${randomUUID()}`],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO agency_individuals (agency_id, individual_id, manages_budget, bills_services, effective_from)
       VALUES ($1, $2, true, false, '2020-01-01')`, [agency, person],
    );
    const program = (await pool.query<{ id: string }>(`SELECT id FROM programs WHERE code = 'DAY_HAB'`)).rows[0]!.id;
    const strategy = (await pool.query<{ id: string }>(
      `INSERT INTO calculation_strategies (individual_id, renewal_date) VALUES ($1, $2) RETURNING id`, [person, dates.end],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO calculation_strategy_lines (strategy_id, program_id, authorized_hours, rate_override)
       VALUES ($1, $2, 100, 20)`, [strategy, program],
    );
    if (physical) {
      const period = (await pool.query<{ id: string }>(
        `INSERT INTO budget_periods (individual_id, label, start_date, end_date, renewal_date)
         VALUES ($1, 'Signed allowance example', $2, $3::date - 1, $3) RETURNING id`, [person, dates.start, dates.end],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO budget_authorizations (budget_period_id, individual_id, program_id, authorized_hours, internal_rate)
         VALUES ($1, $2, $3, 100, 20)`, [period, person, program],
      );
    }
    for (const status of ["confirmed", "needs_review"]) {
      const session = (await pool.query<{ id: string }>(
        `INSERT INTO service_sessions (program_id, physical_hours, group_size, group_detection_status,
           combined_rate, combined_amount, base_individual_rate)
         VALUES ($1, 2, 2, $2, 34, 68, 17) RETURNING id`, [program, status],
      )).rows[0]!.id;
      for (const individual of [person, outsider]) {
        const transaction = (await pool.query<{ id: string }>(
          `INSERT INTO payroll_transactions (individual_id, program_id, period_begin, imported_hours,
             imported_amount, calculated_internal_amount, transaction_fingerprint)
           VALUES ($1, $2, $3, 2, 34, 34, $4) RETURNING id`, [individual, program, dates.today, randomUUID()],
        )).rows[0]!.id;
        await pool.query(
          `INSERT INTO service_allocations (service_session_id, individual_id, payroll_transaction_id,
             allocation_hours, allocated_rate, allocated_amount)
           VALUES ($1, $2, $3, 2, 17, 34)`, [session, individual, transaction],
        );
      }
    }

    const current = (await listCurrentProgramBudgets(pool, { individualId: person, asOf: dates.today }))[0]!;
    expect(current.consumedHours).toBe("3.7000");
    expect((await getIndividualBudgetView(pool, person, strategy)).totals.usedHours).toBe(current.consumedHours);
    expect((await listIndividualBudgetBoard(pool)).find((row) => row.id === person)?.budget?.usedHours).toBe(3.7);
    const history = await getIndividualPeriodActivity(pool, person, dates.start, dates.end);
    expect(history.periods.find((period) => period.key === "calendar")?.programs[0]?.hours).toBe("3.7");
    expect(history.byEmployee[0]?.hours).toBe("3.7000");
    expect(history.byEmployee[0]?.transactions.map((transaction) => transaction.hours).sort()).toEqual(["1.7", "2"]);

    const context: PortalAccessContext = {
      userId: "approved-group-reader", globalRoles: [{ role: "parent", grants: [], denials: [] }],
      individualLinks: [{ individualId: person, relationship: "guardian", grants: [], denials: [] }],
      employeeLinks: [], agencyAccess: [{ agencyId: agency, agencyCode: "GROUP", agencyName: "Group hours example agency", role: "scheduler", grants: [], denials: [] }],
    };
    const model = await getPortalHomeReadModel(pool, context, dates.today.slice(0, 7));
    const hours = { authorized: "100.0000", used: current.consumedHours, remaining: "96.3000" };
    expect(model.individuals).toHaveLength(1);
    expect(model.individuals[0]?.hours).toEqual(hours);
    expect(model.agencies[0]?.budgetHours).toEqual(hours);
    expect(model.agencies[0]?.individuals?.[0]?.hours).toEqual(hours);
    expect(model.individuals[0]).toMatchObject({ dollars: null, billedThisMonth: null, directChecksThisMonth: null });
    expect(model.agencies[0]).toMatchObject({ billedThisMonth: null, setAsideThisMonth: null, payrollNetThisMonth: null });
    expect(JSON.stringify(model)).not.toContain(outsider);
    expect(JSON.stringify(model)).not.toContain("Group excluded example");
  }, 60_000);
});
