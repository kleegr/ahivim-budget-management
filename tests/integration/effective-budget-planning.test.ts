import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getPlanningWorkspace } from "@/lib/data/planning-queries";
import { getIndividualBudgetView } from "@/lib/data/queries";
import { individualProgramForecast, individualScheduleSummary } from "@/lib/data/schedule-queries";
import { projectSeriesAuthorization } from "@/lib/data/series-authorization";
import { calculatePeriodElapsed } from "@/lib/business/utilization";
import type { PgLikePool } from "@/lib/import/commit";
import { createStrategy, explainStrategy, updateStrategy } from "@/lib/manage/calculation-strategies";
import { createIndividual } from "@/lib/manage/individuals";
import { detectConflicts } from "@/lib/manage/schedule";
import {
  closeTestPool,
  hasTestDatabase,
  resetSchema,
  testPool,
  truncateBusinessTables,
} from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
}

async function programId(code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM programs WHERE code = $1`, [code]);
  return rows[0]!.id;
}

suite("canonical budgets in planning (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);

  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES ($1, 'planner-budget@test.local', 'Planner Budget Test', 'x', 'admin')`,
      [ACTOR],
    );
  });

  afterAll(closeTestPool);

  async function strategyBudget(lines: Record<string, string>) {
    const individual = unwrap(await createIndividual(pool, { displayName: "Planning Budget Person" }, ACTOR));
    const strategy = unwrap(await createStrategy(pool, { individualId: individual.id, label: "Annual" }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: strategy.id,
      renewalDate: "2026-10-01",
      hours: lines,
    }, ACTOR));
    return { individualId: individual.id, strategyId: strategy.id };
  }

  it("uses calculation-strategy hours across coverage, preflight, and recurrence renewal periods", async () => {
    const comHab = await programId("COM_HAB");
    const { individualId } = await strategyBudget({ [comHab]: "100" });

    const planning = await getPlanningWorkspace(pool, "2026-08-25");
    const coverage = planning.coverage.find(
      (row) => row.individualId === individualId && row.programId === comHab,
    );
    expect(coverage).toMatchObject({ authorizedHours: "100.0000", actualHours: "0.0000" });

    const warnings = await detectConflicts(pool, {
      employeeId: null,
      programId: comHab,
      individualIds: [individualId],
      sessionDate: "2026-09-15",
      startTime: "09:00",
      endTime: "11:00",
      durationHours: "2",
    });
    expect(warnings.map((warning) => warning.code)).not.toContain("missing_authorization");
    expect(warnings.map((warning) => warning.code)).not.toContain("outside_authorization_dates");

    const projection = await projectSeriesAuthorization(pool, {
      programId: comHab,
      individualIds: [individualId],
      occurrenceDates: ["2026-09-29", "2026-10-01"],
      durationHours: "2",
    });
    expect(projection.individuals[0]).toMatchObject({
      uncoveredOccurrenceCount: 0,
      ambiguousOccurrenceCount: 0,
      projectionSafe: true,
    });
    expect(projection.individuals[0]!.periods).toHaveLength(2);
    expect(projection.individuals[0]!.periods.map((period) => period.seriesOccurrenceCount)).toEqual([1, 1]);
  });

  it("uses canonical group, event, and unallocated payroll hours on every planning surface", async () => {
    const dayHab = await programId("DAY_HAB");
    const { individualId } = await strategyBudget({ [dayHab]: "100" });

    await pool.query(
      `INSERT INTO payroll_transactions (
         individual_id, program_id, period_begin, period_end,
         imported_hours, imported_amount, calculated_internal_amount,
         internal_rate_applied, transaction_fingerprint, is_group_service
       ) VALUES ($1, $2, '2026-08-01', '2026-08-01', 999, 190, 170, 17, $3, true)`,
      [individualId, dayHab, `group-effective-hours:${individualId}`],
    );
    const period = await pool.query<{ id: string }>(
      `INSERT INTO budget_periods
         (individual_id, label, start_date, end_date, period_type, status)
       VALUES ($1, 'Event ledger period', '2026-01-01', '2026-12-31', 'calendar', 'active')
       RETURNING id`,
      [individualId],
    );
    await pool.query(
      `INSERT INTO budget_authorizations
         (budget_period_id, individual_id, program_id, authorized_hours, internal_rate, status)
       VALUES ($1, $2, $3, 100, 17, 'active')`,
      [period.rows[0]!.id, individualId, dayHab],
    );
    await pool.query(
      `INSERT INTO program_budget_events
         (budget_period_id, individual_id, program_id, event_type, service_date,
          hours, amount, source_type, source_id)
       VALUES
         ($1, $2, $3, 'adjust', '2026-08-02', 4, 0, 'planning_test', $4),
         ($1, $2, $3, 'adjust', '2026-08-03', -1, 0, 'planning_test', $5)`,
      [
        period.rows[0]!.id,
        individualId,
        dayHab,
        `planning-positive-adjustment:${individualId}`,
        `planning-negative-adjustment:${individualId}`,
      ],
    );

    const planning = await getPlanningWorkspace(pool, "2026-08-25");
    const coverage = planning.coverage.find(
      (row) => row.individualId === individualId && row.programId === dayHab,
    );
    expect(coverage).toMatchObject({ authorizedHours: "100.0000", actualHours: "13.0000" });

    const forecast = await individualProgramForecast(pool, individualId, dayHab, null, "2026-08-25");
    expect(forecast).toMatchObject({ authorizedHours: "100.0000", actualHours: "13.0000" });

    const summary = await individualScheduleSummary(pool, individualId, new Date("2026-08-25T12:00:00Z"));
    expect(summary?.programs.find((row) => row.programId === dayHab)).toMatchObject({
      authorizedHours: "100.0000",
      usedHours: "13.0000",
    });
  });

  it("keeps every active strategy and calendar-year group hours without a renewal date", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Multi Plan Person" }, ACTOR));
    const comHab = await programId("COM_HAB");
    const respite = await programId("RESPITE");
    const dayHab = await programId("DAY_HAB");

    const first = unwrap(await createStrategy(pool, { individualId: person.id, label: "Plan 1" }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: first.id,
      renewalDate: "2026-10-01",
      hours: { [comHab]: "40" },
    }, ACTOR));
    const second = unwrap(await createStrategy(pool, { individualId: person.id, label: "Plan 2" }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: second.id,
      renewalDate: "2026-11-01",
      hours: { [respite]: "60" },
    }, ACTOR));
    const group = unwrap(await createStrategy(pool, { individualId: person.id, label: "Group" }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: group.id,
      hours: { [dayHab]: "100" },
    }, ACTOR));

    const coverage = (await getPlanningWorkspace(pool, "2026-08-25")).coverage
      .filter((row) => row.individualId === person.id);
    expect(coverage.map((row) => [row.programId, row.authorizedHours])).toEqual(expect.arrayContaining([
      [comHab, "40.0000"],
      [respite, "60.0000"],
      [dayHab, "100.0000"],
    ]));
  });

  it("uses each authorization's own clock for mixed calendar and renewal-year services", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Mixed Period Person" }, ACTOR));
    const dayHab = await programId("DAY_HAB");
    const comHab = await programId("COM_HAB");
    const strategy = unwrap(await createStrategy(pool, { individualId: person.id, label: "Mixed services" }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: strategy.id,
      renewalDate: "2026-10-01",
      hours: { [dayHab]: "100", [comHab]: "40" },
    }, ACTOR));

    const asOf = new Date("2026-08-25T12:00:00Z");
    const summary = await individualScheduleSummary(pool, person.id, asOf);
    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      period: null,
      periodCount: 2,
      totalsAmbiguous: false,
      authorizedHours: "140.0000",
    });

    const day = summary!.programs.find((row) => row.programCode === "DAY_HAB");
    const community = summary!.programs.find((row) => row.programCode === "COM_HAB");
    expect(day).toMatchObject({ startDate: "2026-01-01", endDate: "2026-12-31" });
    expect(community).toMatchObject({ startDate: "2025-10-01", endDate: "2026-09-30" });
    expect(day!.timeElapsedPercent).toBe(calculatePeriodElapsed({
      startDate: "2026-01-01", endDate: "2026-12-31",
    }, asOf).timeElapsedPercent);
    expect(community!.timeElapsedPercent).toBe(calculatePeriodElapsed({
      startDate: "2025-10-01", endDate: "2026-09-30",
    }, asOf).timeElapsedPercent);
    expect(day!.timeElapsedPercent).not.toBe(community!.timeElapsedPercent);
  });

  it("selects one primary same-program strategy and surfaces duplicate source ambiguity", async () => {
    const person = unwrap(await createIndividual(pool, { displayName: "Overlapping Plans Person" }, ACTOR));
    const comHab = await programId("COM_HAB");
    const first = unwrap(await createStrategy(pool, { individualId: person.id, label: "Plan A" }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: first.id,
      renewalDate: "2026-10-01",
      hours: { [comHab]: "40" },
    }, ACTOR));
    const second = unwrap(await createStrategy(pool, { individualId: person.id, label: "Plan B" }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: second.id,
      renewalDate: "2026-11-01",
      hours: { [comHab]: "60" },
    }, ACTOR));

    const summary = await individualScheduleSummary(pool, person.id, new Date("2026-08-25T12:00:00Z"));
    expect(summary).toMatchObject({
      periodCount: 1,
      totalsAmbiguous: false,
      authorizedHours: "40.0000",
      usedHours: "0.0000",
    });
    expect(summary!.programs).toHaveLength(1);
    expect(summary!.programs[0]).toMatchObject({
      startDate: "2025-10-01",
      endDate: "2026-09-30",
      authorizationAmbiguous: false,
      sourceCandidateCount: 2,
      sourceAmbiguous: true,
    });

    const forecast = await individualProgramForecast(pool, person.id, comHab, null, "2026-08-25");
    expect(forecast).toMatchObject({
      authorizedHours: "40.0000",
      authorizationCount: 1,
      authorizationAmbiguous: false,
      sourceCandidateCount: 2,
      sourceAmbiguous: true,
    });
    expect(forecast.authorizations).toHaveLength(1);

    const coverage = (await getPlanningWorkspace(pool, "2026-08-25")).coverage.find(
      (row) => row.individualId === person.id && row.programId === comHab,
    );
    expect(coverage).toMatchObject({
      authorizedHours: "40.0000",
      sourceCandidateCount: 2,
      sourceAmbiguous: true,
    });

    const projection = await projectSeriesAuthorization(pool, {
      programId: comHab,
      individualIds: [person.id],
      occurrenceDates: ["2026-09-01"],
      durationHours: "2",
    });
    expect(projection.individuals[0]).toMatchObject({
      projectionSafe: false,
      periods: [{ sourceCandidateCount: 2, sourceAmbiguous: true }],
    });

    const warnings = await detectConflicts(pool, {
      employeeId: null,
      programId: comHab,
      individualIds: [person.id],
      sessionDate: "2026-09-01",
      startTime: "09:00",
      endTime: "11:00",
      durationHours: "2",
    });
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "ambiguous_authorization",
        message: expect.stringContaining("hours are not added together"),
      }),
    ]));
  });

  it("does not apply a next-January group rate to the prior calendar year", async () => {
    const dayHab = await programId("DAY_HAB");
    const { individualId, strategyId } = await strategyBudget({ [dayHab]: "100" });
    await pool.query(
      `INSERT INTO program_rate_schedules
         (program_id, effective_from, internal_rate, agency_rate, notes)
       VALUES ($1, '2027-01-01', 25, 27, 'Boundary parity test')`,
      [dayHab],
    );
    await pool.query(
      `INSERT INTO payroll_transactions (
         individual_id, program_id, period_begin, period_end,
         imported_hours, calculated_internal_amount, transaction_fingerprint, is_group_service
       ) VALUES ($1, $2, '2026-08-01', '2026-08-01', 999, 170, $3, true)`,
      [individualId, dayHab, `group-rate-boundary:${individualId}`],
    );
    await pool.query(
      `INSERT INTO payroll_transactions (
         individual_id, program_id, period_begin, period_end,
         imported_hours, calculated_internal_amount, transaction_fingerprint, is_group_service
       ) VALUES ($1, $2, '2027-01-01', '2027-01-01', 999, 250, $3, true)`,
      [individualId, dayHab, `group-next-period:${individualId}`],
    );

    const planning = await getPlanningWorkspace(pool, "2026-08-25");
    expect(planning.coverage.find((row) => row.individualId === individualId && row.programId === dayHab))
      .toMatchObject({ authorizedHours: "100.0000", actualHours: "10.0000" });
    expect((await explainStrategy(pool, strategyId))?.lineGross[0]?.rate).toBe("17.0000");
    expect((await getIndividualBudgetView(pool, individualId, strategyId)).lines
      .find((line) => line.programId === dayHab)).toMatchObject({
        perHour: "17.0000",
        usedHours: "10.0000",
      });
  });
});
