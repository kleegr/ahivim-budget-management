import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { getSettlementDashboard } from "@/lib/data/settlements";
import { createEmployee } from "@/lib/manage/employees";
import { mergeEmployees } from "@/lib/manage/employee-merge";
import { createIndividual } from "@/lib/manage/individuals";
import { saveEmployeeDeal } from "@/lib/manage/employee-deals";
import {
  applySettlementCredit,
  recordObligationPayment,
  refreshSettlementObligations,
  reverseSettlementEvent,
  settleObligations,
} from "@/lib/manage/settlements";
import { settlementApplicationDate } from "@/lib/manage/settlement-freshness";
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

const operationKey = (value: number) => `00000000-0000-4000-9000-${String(value).padStart(12, "0")}`;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
}

suite("employee deals and settlement ledger (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES ($1, 'admin@example.test', 'Admin', 'x', 'admin')`,
      [ACTOR],
    );
  });
  afterAll(closeTestPool);

  it("keeps direct check-net and agency-routed base obligations separate and auditable", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Rivka Cohen" }, ACTOR));
    const individual = unwrap(await createIndividual(pool, { displayName: "Avi Green" }, ACTOR));
    unwrap(await saveEmployeeDeal(pool, {
      employeeId: employee.id,
      directRule: "giveback_percent",
      directPercent: "0.10",
      agencyCutPercent: "0.20",
      effectiveFrom: "2026-01-01",
      reason: "Initial written agreement",
    }, ACTOR));

    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, individual_id, check_number, check_date, period_begin, period_end,
          payment_recipient, imported_amount, calculated_internal_amount, total_net_pay,
          transaction_fingerprint)
       VALUES
         ($1,$2,'DIRECT-1','2026-02-15','2026-02-01','2026-02-14','employee','600','500','1200','settle-direct-1'),
         ($1,$2,'DIRECT-1','2026-02-15','2026-02-01','2026-02-14','employee','900','700','1200','settle-direct-2'),
         ($1,$2,'AGENCY-1','2026-02-28','2026-02-15','2026-02-28','excellent_staffing','25','21',NULL,'settle-agency-1')`,
      [employee.id, individual.id],
    );

    const refreshed = unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    expect(refreshed.created).toBe(2);
    const dashboard = await getSettlementDashboard(pool);
    const direct = dashboard.rows.find((row) => row.kind === "employee_giveback")!;
    const agency = dashboard.rows.find((row) => row.kind === "employee_payout")!;

    expect(direct.originalAmount).toBe("120.0000");
    expect(direct.transactionCount).toBe(2);
    expect(direct.calculation).toMatchObject({
      checkNet: "1200.0000",
      checkGross: "1500.0000",
      withholdingDisplayOnly: "300.0000",
      employeeKeeps: "1080.0000",
    });
    expect(agency.originalAmount).toBe("16.8000");
    expect(agency.calculation).toMatchObject({
      billedAmount: "25.0000",
      baseAmount: "21.0000",
      agencySpread: "4.0000",
      agencyCut: "4.2000",
      employeePayable: "16.8000",
    });

    const partial = unwrap(await recordObligationPayment(pool, {
      obligationId: direct.id,
      amount: "50",
      occurredOn: "2026-03-01",
      operationKey: operationKey(1),
      reference: "DEP-100",
    }, ACTOR));
    let after = await getSettlementDashboard(pool);
    expect(after.rows.find((row) => row.id === direct.id)).toMatchObject({ state: "partial", balance: "70.0000" });

    const extra = unwrap(await recordObligationPayment(pool, {
      obligationId: direct.id,
      amount: "80",
      occurredOn: "2026-03-02",
      operationKey: operationKey(2),
      reference: "DEP-101",
    }, ACTOR));
    after = await getSettlementDashboard(pool);
    expect(after.rows.find((row) => row.id === direct.id)).toMatchObject({ state: "credit", balance: "-10.0000" });

    unwrap(await reverseSettlementEvent(pool, extra.eventIds[0], "Deposit was returned", ACTOR, operationKey(3)));
    after = await getSettlementDashboard(pool);
    expect(after.rows.find((row) => row.id === direct.id)).toMatchObject({ state: "partial", balance: "70.0000" });
    expect(after.events.find((event) => event.id === partial.eventIds[0])?.reference).toBe("DEP-100");

    unwrap(await settleObligations(pool, {
      obligationIds: [agency.id],
      occurredOn: "2026-03-03",
      operationKey: operationKey(4),
      note: "Payroll sent",
    }, ACTOR));
    after = await getSettlementDashboard(pool);
    expect(after.rows.find((row) => row.id === agency.id)).toMatchObject({ state: "settled", balance: "0.0000" });

    const staleBatch = await settleObligations(pool, {
      obligationIds: [direct.id, agency.id],
      occurredOn: "2026-03-04",
      operationKey: operationKey(5),
    }, ACTOR);
    expect(staleBatch).toMatchObject({ ok: false, code: "conflict" });
    after = await getSettlementDashboard(pool);
    expect(after.rows.find((row) => row.id === direct.id)).toMatchObject({ state: "partial", balance: "70.0000" });

    const rerun = unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    expect(rerun.created).toBe(0);
    expect((await getSettlementDashboard(pool)).rows).toHaveLength(2);
  });

  it("snapshots a deal change and creates a delta instead of rewriting actioned history", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Sara Weiss" }, ACTOR));
    const individual = unwrap(await createIndividual(pool, { displayName: "Noah Levy" }, ACTOR));
    unwrap(await saveEmployeeDeal(pool, {
      employeeId: employee.id,
      directRule: "giveback_percent",
      directPercent: "0.10",
      agencyCutPercent: "0",
      effectiveFrom: "2026-01-01",
      reason: "Initial agreement",
    }, ACTOR));
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, individual_id, check_number, check_date, payment_recipient,
          imported_amount, calculated_internal_amount, total_net_pay, transaction_fingerprint)
       VALUES ($1,$2,'D-2','2026-02-01','employee','1000','900','1000','settle-revision-1')`,
      [employee.id, individual.id],
    );
    unwrap(await refreshSettlementObligations(pool, { employeeId: employee.id }, ACTOR));
    let dashboard = await getSettlementDashboard(pool);
    const original = dashboard.rows[0];
    unwrap(await settleObligations(pool, {
      obligationIds: [original.id],
      occurredOn: "2026-02-02",
      operationKey: operationKey(6),
    }, ACTOR));

    unwrap(await saveEmployeeDeal(pool, {
      employeeId: employee.id,
      directRule: "giveback_percent",
      directPercent: "0.20",
      agencyCutPercent: "0",
      effectiveFrom: "2026-01-01",
      reason: "Corrected signed percentage",
    }, ACTOR));
    const refreshed = unwrap(await refreshSettlementObligations(pool, { employeeId: employee.id }, ACTOR));
    expect(refreshed.adjusted).toBe(1);
    dashboard = await getSettlementDashboard(pool);
    expect(dashboard.rows.find((row) => row.id === original.id)?.originalAmount).toBe("100.0000");
    expect(dashboard.rows.find((row) => row.kind.endsWith("_correction"))).toMatchObject({
      direction: "receivable",
      originalAmount: "100.0000",
    });

    unwrap(await saveEmployeeDeal(pool, {
      employeeId: employee.id,
      directRule: "giveback_percent",
      directPercent: "0.15",
      agencyCutPercent: "0",
      effectiveFrom: "2026-01-01",
      reason: "Interim correction",
    }, ACTOR));
    expect(unwrap(await refreshSettlementObligations(pool, { employeeId: employee.id }, ACTOR)).adjusted).toBe(1);

    unwrap(await saveEmployeeDeal(pool, {
      employeeId: employee.id,
      directRule: "giveback_percent",
      directPercent: "0.20",
      agencyCutPercent: "0",
      effectiveFrom: "2026-01-01",
      reason: "Restored corrected percentage",
    }, ACTOR));
    expect(unwrap(await refreshSettlementObligations(pool, { employeeId: employee.id }, ACTOR)).adjusted).toBe(1);

    dashboard = await getSettlementDashboard(pool);
    const corrections = dashboard.rows.filter((row) => row.kind.endsWith("_correction"));
    expect(corrections.filter((row) => row.direction === "receivable").map((row) => row.originalAmount).sort()).toEqual([
      "100.0000",
      "50.0000",
    ]);
    expect(corrections.filter((row) => row.direction === "payable").map((row) => row.originalAmount)).toEqual(["50.0000"]);

    const revisions = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM employee_deal_revisions`,
    );
    expect(revisions.rows[0].count).toBe("3");
  });

  it("preserves a partially paid obligation root across an employee identity merge", async () => {
    const source = unwrap(await createEmployee(pool, { displayName: "Rachel Greenberg" }, ACTOR));
    const target = unwrap(await createEmployee(pool, { displayName: "R. Greenberg" }, ACTOR));
    const individual = unwrap(await createIndividual(pool, { displayName: "David Klein" }, ACTOR));
    unwrap(await saveEmployeeDeal(pool, {
      employeeId: source.id,
      directRule: "giveback_percent",
      directPercent: "0.10",
      agencyCutPercent: "0",
      effectiveFrom: "2026-01-01",
      reason: "Identity merge regression coverage",
    }, ACTOR));
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, individual_id, check_number, check_date, payment_recipient,
          imported_amount, total_net_pay, transaction_fingerprint)
       VALUES ($1,$2,'MERGE-1','2026-03-15','employee','1000','1000','settle-identity-merge-1')`,
      [source.id, individual.id],
    );

    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    let dashboard = await getSettlementDashboard(pool);
    const original = dashboard.rows.find((row) => row.checkNumber === "MERGE-1")!;
    const originalRoot = await pool.query<{ source_key: string }>(
      `SELECT source_key FROM settlement_obligations WHERE id = $1`,
      [original.id],
    );
    unwrap(await recordObligationPayment(pool, {
      obligationId: original.id,
      amount: "25",
      occurredOn: "2026-03-20",
      operationKey: operationKey(10),
      reference: "MERGE-PARTIAL-1",
    }, ACTOR));

    const merged = unwrap(await mergeEmployees(
      pool,
      { keepId: target.id, mergeId: source.id },
      ACTOR,
      "Duplicate employee identity",
    ));
    expect(merged.repointed).toMatchObject({
      employee_deals: 1,
      payroll_transactions: 1,
      settlement_events: 1,
      settlement_obligations: 1,
    });

    const refreshed = unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    expect(refreshed).toMatchObject({ created: 0, adjusted: 0, voided: 0 });
    dashboard = await getSettlementDashboard(pool);

    expect(dashboard.rows).toHaveLength(1);
    expect(dashboard.rows[0]).toMatchObject({
      id: original.id,
      personId: target.id,
      originalAmount: "100.0000",
      appliedAmount: "25.0000",
      balance: "75.0000",
      state: "partial",
    });
    expect(dashboard.summary).toMatchObject({
      employeesOwe: "75.0000",
      originalTotal: "100.0000",
      appliedTotal: "25.0000",
    });

    const roots = await pool.query<{
      id: string;
      source_key: string;
      employee_id: string;
      correction: boolean;
    }>(
      `SELECT id, source_key, employee_id,
              calculation_metadata ? 'adjustmentForObligationId' AS correction
         FROM settlement_obligations`,
    );
    expect(roots.rows).toEqual([{
      id: original.id,
      source_key: originalRoot.rows[0].source_key,
      employee_id: target.id,
      correction: false,
    }]);
  });

  it("applies overpayment credit once and reverses both sides together", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Miriam Adler" }, ACTOR));
    const individual = unwrap(await createIndividual(pool, { displayName: "Leah Gold" }, ACTOR));
    unwrap(await saveEmployeeDeal(pool, {
      employeeId: employee.id,
      directRule: "giveback_percent",
      directPercent: "0.10",
      agencyCutPercent: "0",
      effectiveFrom: "2026-01-01",
      reason: "Initial agreement",
    }, ACTOR));
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, individual_id, check_number, check_date, payment_recipient,
          imported_amount, total_net_pay, transaction_fingerprint)
       VALUES
         ($1,$2,'CREDIT-1','2026-04-01','employee','100','100','credit-source'),
         ($1,$2,'CREDIT-2','2026-04-15','employee','200','200','credit-target')`,
      [employee.id, individual.id],
    );
    unwrap(await refreshSettlementObligations(pool, { employeeId: employee.id }, ACTOR));
    let dashboard = await getSettlementDashboard(pool);
    const source = dashboard.rows.find((row) => row.checkNumber === "CREDIT-1")!;
    const target = dashboard.rows.find((row) => row.checkNumber === "CREDIT-2")!;

    const overpayment = unwrap(await recordObligationPayment(pool, {
      obligationId: source.id,
      amount: "15",
      occurredOn: "2026-04-20",
      operationKey: operationKey(20),
    }, ACTOR));
    const overpaymentReplay = unwrap(await recordObligationPayment(pool, {
      obligationId: source.id,
      amount: "15",
      occurredOn: "2026-04-20",
      operationKey: operationKey(20),
    }, ACTOR));
    expect(overpaymentReplay).toEqual(overpayment);

    const applied = unwrap(await applySettlementCredit(pool, {
      sourceObligationId: source.id,
      targetObligationId: target.id,
      amount: "5",
      occurredOn: "2026-04-21",
      operationKey: operationKey(21),
    }, ACTOR));
    const replay = unwrap(await applySettlementCredit(pool, {
      sourceObligationId: source.id,
      targetObligationId: target.id,
      amount: "5",
      occurredOn: "2026-04-21",
      operationKey: operationKey(21),
    }, ACTOR));
    expect(replay).toEqual(applied);

    dashboard = await getSettlementDashboard(pool);
    expect(dashboard.rows.find((row) => row.id === source.id)).toMatchObject({ state: "settled", balance: "0.0000" });
    expect(dashboard.rows.find((row) => row.id === target.id)).toMatchObject({ state: "partial", balance: "15.0000" });

    const eventCount = dashboard.events.length;
    unwrap(await reverseSettlementEvent(pool, applied.eventIds[0], "Credit was applied to the wrong check", ACTOR, operationKey(22)));
    dashboard = await getSettlementDashboard(pool);
    expect(dashboard.rows.find((row) => row.id === source.id)).toMatchObject({ state: "credit", balance: "-5.0000" });
    expect(dashboard.rows.find((row) => row.id === target.id)).toMatchObject({ state: "open", balance: "20.0000" });
    expect(dashboard.events.length).toBe(eventCount + 2);
  });

  it("marks financial source changes dirty and blocks money actions until a clean refresh", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Freshness Test" }, ACTOR));
    const individual = unwrap(await createIndividual(pool, { displayName: "Freshness Person" }, ACTOR));
    unwrap(await saveEmployeeDeal(pool, {
      employeeId: employee.id,
      directRule: "giveback_percent",
      directPercent: "0.10",
      agencyCutPercent: "0",
      effectiveFrom: "2026-01-01",
      reason: "Freshness coverage",
    }, ACTOR));
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, individual_id, check_number, check_date, payment_recipient,
          imported_amount, total_net_pay, transaction_fingerprint)
       VALUES ($1,$2,'FRESH-1','2026-05-01','employee','100','100','freshness-source')`,
      [employee.id, individual.id],
    );

    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    let dashboard = await getSettlementDashboard(pool);
    expect(dashboard.freshness.dirty).toBe(false);
    const obligation = dashboard.rows.find((row) => row.checkNumber === "FRESH-1")!;

    await pool.query(
      `UPDATE payroll_transactions SET total_net_pay = '200', updated_at = now()
        WHERE transaction_fingerprint = 'freshness-source'`,
    );
    dashboard = await getSettlementDashboard(pool);
    expect(dashboard.freshness.dirty).toBe(true);
    expect(dashboard.freshness.sourceVersion).not.toBe(dashboard.freshness.refreshedVersion);

    const blocked = await recordObligationPayment(pool, {
      obligationId: obligation.id,
      amount: "5",
      occurredOn: "2026-05-02",
      operationKey: operationKey(30),
    }, ACTOR);
    expect(blocked).toMatchObject({ ok: false, code: "conflict" });

    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    dashboard = await getSettlementDashboard(pool);
    expect(dashboard.freshness.dirty).toBe(false);
    expect(dashboard.freshness.refreshedForDate).toBe(settlementApplicationDate());
    expect(dashboard.rows.find((row) => row.id === obligation.id)?.originalAmount).toBe("20.0000");

    await pool.query(
      `UPDATE settlement_ledger_state
          SET refreshed_for_date = $1::date - 1
        WHERE singleton = true`,
      [settlementApplicationDate()],
    );
    dashboard = await getSettlementDashboard(pool);
    expect(dashboard.freshness).toMatchObject({
      dirty: true,
      sourceVersion: dashboard.freshness.refreshedVersion,
    });
    const clockBlocked = await recordObligationPayment(pool, {
      obligationId: obligation.id,
      amount: "5",
      occurredOn: "2026-05-02",
      operationKey: operationKey(31),
    }, ACTOR);
    expect(clockBlocked).toMatchObject({ ok: false, code: "conflict" });

    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    dashboard = await getSettlementDashboard(pool);
    expect(dashboard.freshness).toMatchObject({
      dirty: false,
      refreshedForDate: settlementApplicationDate(),
    });
    unwrap(await recordObligationPayment(pool, {
      obligationId: obligation.id,
      amount: "5",
      occurredOn: "2026-05-02",
      operationKey: operationKey(32),
    }, ACTOR));
  });
});
