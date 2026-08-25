import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getIndividualPeriodActivity,
  listIndividualBudgetBoard,
  type PlannedPeriodProgram,
} from "@/lib/data/queries";
import type { PgLikePool } from "@/lib/import/commit";
import { createStrategy, updateStrategy } from "@/lib/manage/calculation-strategies";
import { createIndividual } from "@/lib/manage/individuals";
import {
  closeTestPool,
  hasTestDatabase,
  resetSchema,
  testPool,
  truncateBusinessTables,
} from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
const AS_OF = new Date("2026-08-25T12:00:00.000Z");
let pool: PgLikePool;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
}

async function program(code: string): Promise<{ id: string; name: string; code: string }> {
  const { rows } = await pool.query<{ id: string; name: string; code: string }>(
    `SELECT id, name, code FROM programs WHERE code = $1`,
    [code],
  );
  return rows[0]!;
}

suite("budget board and history period parity (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);

  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES ($1, 'budget-board@test.local', 'Budget Board Test', 'x', 'admin')`,
      [ACTOR],
    );
  });

  afterAll(closeTestPool);

  it("keeps every active strategy, resolves the period-end rate, and excludes renewal-day billing", async () => {
    const comHab = await program("COM_HAB");
    const respite = await program("RESPITE");
    const dayHab = await program("DAY_HAB");
    const individual = unwrap(await createIndividual(pool, { displayName: "Board History Person" }, ACTOR));

    const primary = unwrap(await createStrategy(pool, { individualId: individual.id, label: "Primary" }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: primary.id,
      renewalDate: "2026-10-01",
      hours: { [comHab.id]: "40" },
    }, ACTOR));

    const second = unwrap(await createStrategy(pool, { individualId: individual.id, label: "Second" }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: second.id,
      renewalDate: "2026-11-01",
      hours: { [respite.id]: "60" },
    }, ACTOR));

    const group = unwrap(await createStrategy(pool, { individualId: individual.id, label: "Calendar group" }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: group.id,
      hours: { [dayHab.id]: "100" },
    }, ACTOR));
    await pool.query(
      `UPDATE calculation_strategy_lines
          SET rate_override = 34, rate_override_effective_from = '2027-01-01'
        WHERE strategy_id = $1 AND program_id = $2`,
      [group.id, dayHab.id],
    );

    await pool.query(`DELETE FROM program_rate_schedules WHERE program_id = $1`, [dayHab.id]);
    await pool.query(
      `INSERT INTO program_rate_schedules
         (program_id, effective_from, effective_to, internal_rate, agency_rate, notes)
       VALUES
         ($1, '2026-01-01', '2026-12-31', 17, 19, 'Current calendar rate'),
         ($1, '2027-01-01', NULL, 25, 27, 'Future calendar rate')`,
      [dayHab.id],
    );

    await pool.query(
      `INSERT INTO payroll_transactions (
         individual_id, program_id, period_begin, period_end,
         imported_hours, imported_amount, calculated_internal_amount,
         internal_rate_applied, transaction_fingerprint, is_group_service
       ) VALUES
         ($1, $2, '2026-09-30', '2026-09-30', 2, 42, 42, 21, $4, false),
         ($1, $2, '2026-10-01', '2026-10-01', 7, 147, 147, 21, $5, false),
         ($1, $3, '2026-08-01', '2026-08-01', 999, 190, 170, 17, $6, true),
         ($1, $3, '2027-01-01', '2027-01-01', 999, 270, 250, 25, $7, true)`,
      [
        individual.id,
        comHab.id,
        dayHab.id,
        `board-history-inside:${individual.id}`,
        `board-history-renewal:${individual.id}`,
        `board-history-group:${individual.id}`,
        `board-history-future:${individual.id}`,
      ],
    );

    const boardRow = (await listIndividualBudgetBoard(pool, AS_OF))
      .find((row) => row.id === individual.id);
    expect(boardRow?.programs).toEqual(expect.arrayContaining([comHab.name, respite.name, dayHab.name]));
    expect(boardRow?.budget).toMatchObject({
      plans: 3,
      usedHours: 12,
      hoursLeft: 188,
      transactionCount: 2,
      renews: "2026-10-01",
    });

    const planned: PlannedPeriodProgram[] = [comHab, respite, dayHab];
    const history = await getIndividualPeriodActivity(
      pool,
      individual.id,
      "2025-10-01",
      "2026-10-01",
      undefined,
      planned,
      AS_OF,
    );
    const renewal = history.periods.find((period) => period.key === "renewal");
    const calendar = history.periods.find((period) => period.key === "calendar");
    expect(renewal?.programs.find((entry) => entry.id === comHab.id)?.hours).toBe("2");
    expect(renewal?.programs.find((entry) => entry.id === respite.id)?.hours).toBe("0");
    expect(calendar?.programs.find((entry) => entry.id === dayHab.id)?.hours).toBe("10");
    expect(history.byEmployee.flatMap((employee) => employee.transactions).map((transaction) => transaction.periodBegin))
      .toEqual(expect.arrayContaining(["2026-08-01", "2026-09-30"]));
    expect(history.byEmployee.flatMap((employee) => employee.transactions).map((transaction) => transaction.periodBegin))
      .not.toEqual(expect.arrayContaining(["2026-10-01", "2027-01-01"]));
  });
});
