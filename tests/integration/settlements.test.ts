import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { getPersonSettlementBalance, getSettlementDashboard } from "@/lib/data/settlements";
import { getFinancialDashboard } from "@/lib/data/financial-dashboard";
import { getCollectionsWorkspace, getIndividualMasserStatement } from "@/lib/data/direct-pay-operations";
import { fullAccess } from "@/lib/auth/access";
import { createEmployee } from "@/lib/manage/employees";
import { mergeEmployees } from "@/lib/manage/employee-merge";
import { createIndividual } from "@/lib/manage/individuals";
import { saveEmployeeDeal } from "@/lib/manage/employee-deals";
import { savePayrollCheck } from "@/lib/manage/direct-pay-operations";
import { createStrategy, updateStrategy } from "@/lib/manage/calculation-strategies";
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

async function verifyPayrollCheck(input: {
  employeeId: string;
  checkNumber: string;
  checkDate: string;
  actualNet: string;
  periodBegin?: string;
  periodEnd?: string;
}) {
  return unwrap(await savePayrollCheck(pool, {
    ...input,
    verificationStatus: "verified",
  }, ACTOR));
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

    const payrollCheck = unwrap(await savePayrollCheck(pool, {
      employeeId: employee.id,
      checkNumber: "DIRECT-1",
      checkDate: "2026-02-15",
      periodBegin: "2026-02-01",
      periodEnd: "2026-02-14",
      actualGross: "1500",
      actualNet: "1200",
      taxWithheld: "300",
      verificationStatus: "verified",
    }, ACTOR));
    expect(payrollCheck.linkedTransactions).toBe(2);

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
      taxWithheldDisplayOnly: "300.0000",
      totalDeductionsDisplayOnly: "300.0000",
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

    const correctedCheck = unwrap(await savePayrollCheck(pool, {
      id: payrollCheck.id,
      employeeId: employee.id,
      checkNumber: "DIRECT-1-CORRECTED",
      checkDate: "2026-02-16",
      periodBegin: "2026-02-01",
      periodEnd: "2026-02-14",
      actualGross: "1500",
      actualNet: "1200",
      taxWithheld: "300",
      verificationStatus: "verified",
    }, ACTOR));
    expect(correctedCheck.linkedTransactions).toBe(2);
    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    const afterCorrection = await getSettlementDashboard(pool);
    expect(afterCorrection.rows.filter((row) => row.kind === "employee_giveback")).toHaveLength(1);
    expect(afterCorrection.rows.find((row) => row.kind === "employee_giveback")?.id).toBe(direct.id);

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

  it("nets append-only corrections into the current individual reserve balance", async () => {
    const individual = unwrap(await createIndividual(pool, { displayName: "Corrected Reserve Person" }, ACTOR));
    const strategy = unwrap(await createStrategy(pool, { individualId: individual.id }, ACTOR));
    unwrap(await updateStrategy(pool, { id: strategy.id, afterAll: "80" }, ACTOR));
    const roots = await pool.query<{ id: string; source_key: string }>(
      `INSERT INTO settlement_obligations
         (source_key, kind, direction, individual_id, calculation_strategy_id,
          original_amount, period_begin, period_end, calculation_metadata, created_by_user_id)
       VALUES
         ('corrected-reserve-root', 'individual_masser', 'reserve', $1, $2,
          1000, '2026-01-01', '2027-01-01',
          '{"flow":"individual_plan","monthlyAmount":"100"}'::jsonb, $3),
         ('retired-cut-root', 'individual_cut_1', 'reserve', $1, $2,
          300, '2026-01-01', '2027-01-01',
          '{"flow":"individual_plan","monthlyAmount":"30"}'::jsonb, $3)
       RETURNING id, source_key`,
      [individual.id, strategy.id, ACTOR],
    );
    const reserveRoot = roots.rows.find((row) => row.source_key === "corrected-reserve-root")!;
    const retiredRoot = roots.rows.find((row) => row.source_key === "retired-cut-root")!;

    await pool.query(
      `INSERT INTO settlement_obligations
         (source_key, kind, direction, individual_id, calculation_strategy_id,
          original_amount, period_begin, period_end, calculation_metadata, created_by_user_id)
       VALUES
         ('corrected-reserve-delta', 'individual_masser_correction', 'receivable', $1, $2,
          200, '2026-01-01', '2027-01-01',
          jsonb_build_object(
            'flow', 'individual_plan',
            'monthlyAmount', '80',
            'adjustmentForObligationId', $3::text,
            'recalculatedOriginalAmount', '800.0000',
            'recalculatedDirection', 'reserve'
          ), $5),
         ('retired-cut-delta', 'individual_cut_1_correction', 'receivable', $1, $2,
          300, '2026-01-01', '2027-01-01',
          jsonb_build_object(
            'flow', 'individual_plan',
            'monthlyAmount', '30',
            'adjustmentForObligationId', $4::text,
            'recalculatedOriginalAmount', '0.0000',
            'recalculatedDirection', 'reserve'
          ), $5)`,
      [individual.id, strategy.id, reserveRoot.id, retiredRoot.id, ACTOR],
    );
    await pool.query(
      `INSERT INTO settlement_events
         (settlement_obligation_id, individual_id, event_type, amount, occurred_on, created_by_user_id)
       VALUES
         ($1, $3, 'set_aside', 400, '2026-08-10', $4),
         ($2, $3, 'set_aside', 100, '2026-08-10', $4)`,
      [reserveRoot.id, retiredRoot.id, individual.id, ACTOR],
    );

    expect(await getPersonSettlementBalance(pool, { individualId: individual.id })).toEqual({
      payable: "0.0000",
      receivable: "0.0000",
      reserve: "400.0000",
      credit: "100.0000",
      openItems: 1,
    });

    const collections = await getCollectionsWorkspace(pool, fullAccess(ACTOR, "admin"), "2026-08");
    expect(collections.individualSetAsides.find((row) => row.individualId === individual.id)).toMatchObject({
      approvedMonthlyPlan: "80.0000",
      setAsideThisMonth: "500.0000",
      remainingSetAside: "400.0000",
      activePlans: 1,
      trackedPlans: 1,
      missingRenewalPlans: 1,
    });
  });

  it("sums every active approved final while ledger activity follows each plan period", async () => {
    const individual = unwrap(await createIndividual(pool, { displayName: "Renewal Boundary Person" }, ACTOR));
    const oldStrategy = unwrap(await createStrategy(pool, {
      individualId: individual.id,
      label: "Prior plan",
    }, ACTOR));
    const newStrategy = unwrap(await createStrategy(pool, {
      individualId: individual.id,
      label: "Renewed plan",
    }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: oldStrategy.id,
      renewalDate: "2026-09-15",
      afterAll: "10",
    }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: newStrategy.id,
      renewalDate: "2027-09-15",
      afterAll: "20",
    }, ACTOR));
    const roots = await pool.query<{ id: string; source_key: string }>(
      `INSERT INTO settlement_obligations
         (source_key, kind, direction, individual_id, calculation_strategy_id,
          original_amount, period_begin, period_end, calculation_metadata, created_by_user_id)
       VALUES
         ('month-end-prior-plan', 'individual_masser', 'reserve', $1, $2,
          120, '2025-09-15', '2026-09-15',
          '{"flow":"individual_plan","monthlyAmount":"10"}'::jsonb, $4),
         ('month-end-renewed-plan', 'individual_masser', 'reserve', $1, $3,
          240, '2026-09-15', '2027-09-15',
          '{"flow":"individual_plan","monthlyAmount":"20"}'::jsonb, $4)
       RETURNING id, source_key`,
      [individual.id, oldStrategy.id, newStrategy.id, ACTOR],
    );
    const oldRoot = roots.rows.find((row) => row.source_key === "month-end-prior-plan")!;
    const newRoot = roots.rows.find((row) => row.source_key === "month-end-renewed-plan")!;
    await pool.query(
      `INSERT INTO settlement_events
         (settlement_obligation_id, individual_id, event_type, amount, occurred_on, created_by_user_id)
       VALUES
         ($1, $3, 'set_aside', 40, '2026-09-10', $4),
         ($2, $3, 'set_aside', 50, '2026-09-20', $4)`,
      [oldRoot.id, newRoot.id, individual.id, ACTOR],
    );

    const collections = await getCollectionsWorkspace(pool, fullAccess(ACTOR, "admin"), "2026-09");
    expect(collections.individualSetAsides.find((row) => row.individualId === individual.id)).toMatchObject({
      approvedMonthlyPlan: "30.0000",
      setAsideThisMonth: "50.0000",
      remainingSetAside: "190.0000",
      activePlans: 2,
      trackedPlans: 1,
      missingRenewalPlans: 0,
    });

    const statement = await getIndividualMasserStatement(
      pool,
      fullAccess(ACTOR, "admin"),
      individual.id,
      "2026-09",
    );
    expect(statement).toMatchObject({
      approvedMonthlyPlan: "30.0000",
      activePlans: 2,
      trackedPlans: 1,
      missingRenewalPlans: 0,
      recordedReserve: "50.0000",
      remainingReserve: "190.0000",
      history: [{ month: "2026-09", setAside: "50.0000", reversals: "0.0000" }],
    });
  });

  it("keeps the approved monthly final fixed regardless of the annual divisor", async () => {
    const individual = unwrap(await createIndividual(pool, { displayName: "Late Start Reserve" }, ACTOR));
    const strategy = unwrap(await createStrategy(pool, { individualId: individual.id }, ACTOR));
    unwrap(await updateStrategy(pool, {
      id: strategy.id,
      renewalDate: "2027-01-01",
      monthDivisor: "7",
      afterAll: "80",
    }, ACTOR));
    await pool.query(
      `INSERT INTO settlement_obligations
         (source_key, kind, direction, individual_id, calculation_strategy_id,
          original_amount, period_begin, period_end, calculation_metadata, created_by_user_id)
       VALUES
         ('late-start-reserve', 'individual_masser', 'reserve', $1, $2,
          560, '2026-01-01', '2027-01-01',
          '{"flow":"individual_plan","monthlyAmount":"80","monthDivisor":"7"}'::jsonb, $3)`,
      [individual.id, strategy.id, ACTOR],
    );

    const may = await getCollectionsWorkspace(pool, fullAccess(ACTOR, "admin"), "2026-05");
    const june = await getCollectionsWorkspace(pool, fullAccess(ACTOR, "admin"), "2026-06");
    const december = await getCollectionsWorkspace(pool, fullAccess(ACTOR, "admin"), "2026-12");

    expect(may.individualSetAsides.find((row) => row.individualId === individual.id)?.approvedMonthlyPlan).toBe("80.0000");
    expect(june.individualSetAsides.find((row) => row.individualId === individual.id)?.approvedMonthlyPlan).toBe("80.0000");
    expect(december.individualSetAsides.find((row) => row.individualId === individual.id)?.approvedMonthlyPlan).toBe("80.0000");
  });

  it("links an exact missing-identity row without capturing a reused check number", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Exact Source Employee" }, ACTOR));
    const individual = unwrap(await createIndividual(pool, { displayName: "Exact Source Individual" }, ACTOR));
    const inserted = await pool.query<{ id: string; transaction_fingerprint: string }>(
      `INSERT INTO payroll_transactions
         (employee_id, individual_id, check_number, check_date, payment_recipient,
          imported_amount, total_net_pay, transaction_fingerprint)
       VALUES
         ($1,$2,NULL,NULL,'employee','100',NULL,'exact-missing-identity'),
         ($1,$2,'REUSED-1','2026-09-15','employee','200',NULL,'exact-reused-number')
       RETURNING id, transaction_fingerprint`,
      [employee.id, individual.id],
    );
    const sourceId = inserted.rows.find((row) => row.transaction_fingerprint === "exact-missing-identity")!.id;

    const saved = unwrap(await savePayrollCheck(pool, {
      employeeId: employee.id,
      checkNumber: "REUSED-1",
      checkDate: "2026-08-15",
      actualNet: "80",
      sourceTransactionIds: [sourceId],
    }, ACTOR));

    expect(saved.linkedTransactions).toBe(1);
    const linked = await pool.query<{ transaction_fingerprint: string; payroll_check_id: string | null }>(
      `SELECT transaction_fingerprint, payroll_check_id
         FROM payroll_transactions
        WHERE transaction_fingerprint IN ('exact-missing-identity','exact-reused-number')
        ORDER BY transaction_fingerprint`,
    );
    expect(linked.rows).toEqual([
      { transaction_fingerprint: "exact-missing-identity", payroll_check_id: saved.id },
      { transaction_fingerprint: "exact-reused-number", payroll_check_id: null },
    ]);
  });

  it("rejects missing and cross-employee exact source ids before creating a check", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Requested Employee" }, ACTOR));
    const other = unwrap(await createEmployee(pool, { displayName: "Other Employee" }, ACTOR));
    const source = await pool.query<{ id: string }>(
      `INSERT INTO payroll_transactions
         (employee_id, check_date, payment_recipient, imported_amount, transaction_fingerprint)
       VALUES ($1,'2026-08-15','employee','100','cross-employee-source')
       RETURNING id`,
      [other.id],
    );

    const missing = await savePayrollCheck(pool, {
      employeeId: employee.id,
      checkDate: "2026-08-15",
      actualNet: "80",
      sourceTransactionIds: ["00000000-0000-4000-8000-000000009999"],
    }, ACTOR);
    expect(missing).toMatchObject({ ok: false, code: "not_found" });

    const crossEmployee = await savePayrollCheck(pool, {
      employeeId: employee.id,
      checkDate: "2026-08-15",
      actualNet: "80",
      sourceTransactionIds: [source.rows[0]!.id],
    }, ACTOR);
    expect(crossEmployee).toMatchObject({ ok: false, code: "forbidden" });

    const checkCount = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM employee_payroll_checks`);
    expect(checkCount.rows[0]?.count).toBe("0");
  });

  it("does not combine taxes for reused check numbers across employees or pay periods", async () => {
    const firstEmployee = unwrap(await createEmployee(pool, { displayName: "First Tax Employee" }, ACTOR));
    const secondEmployee = unwrap(await createEmployee(pool, { displayName: "Second Tax Employee" }, ACTOR));
    const firstIndividual = unwrap(await createIndividual(pool, { displayName: "First Tax Individual" }, ACTOR));
    const secondIndividual = unwrap(await createIndividual(pool, { displayName: "Second Tax Individual" }, ACTOR));
    const program = await pool.query<{ id: string }>(
      `INSERT INTO programs (code, name) VALUES ('TAX_TEST', 'Tax Test') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO program_rate_schedules (program_id, effective_from, internal_rate)
       VALUES ($1, '2020-01-01', '1')`,
      [program.rows[0]!.id],
    );
    for (const individualId of [firstIndividual.id, secondIndividual.id]) {
      const strategy = unwrap(await createStrategy(pool, { individualId }, ACTOR));
      unwrap(await updateStrategy(pool, {
        id: strategy.id,
        renewalDate: "2027-01-01",
        hours: { [program.rows[0]!.id]: "1000" },
      }, ACTOR));
    }
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, individual_id, check_number, check_date, period_begin, period_end,
          payment_recipient, imported_amount, total_net_pay, transaction_fingerprint)
       VALUES
         ($1,$2,'REUSED-TAX','2026-08-15','2026-08-01','2026-08-14','employee','100','80','reused-tax-1'),
         ($3,$4,'REUSED-TAX','2026-09-15','2026-09-01','2026-09-14','employee','200','150','reused-tax-2')`,
      [firstEmployee.id, firstIndividual.id, secondEmployee.id, secondIndividual.id],
    );

    const financial = await getFinancialDashboard(pool);
    expect(financial.rows.find((row) => row.individualId === firstIndividual.id)?.taxesAll).toBe("20.00");
    expect(financial.rows.find((row) => row.individualId === secondIndividual.id)?.taxesAll).toBe("50.00");
  });

  it("keeps an unverified payroll check pending until verification", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Pending Check Employee" }, ACTOR));
    unwrap(await saveEmployeeDeal(pool, {
      employeeId: employee.id,
      directRule: "giveback_percent",
      directPercent: "0.10",
      agencyCutPercent: "0",
      effectiveFrom: "2026-01-01",
      reason: "Initial direct-pay agreement",
    }, ACTOR));
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, check_number, check_date, period_begin, period_end,
          payment_recipient, imported_amount, total_net_pay, transaction_fingerprint)
       VALUES ($1, 'PENDING-1', '2026-02-15', '2026-02-01', '2026-02-14',
               'employee', '900', '800', 'settle-pending-check-1')`,
      [employee.id],
    );

    const pending = unwrap(await savePayrollCheck(pool, {
      employeeId: employee.id,
      checkNumber: "PENDING-1",
      checkDate: "2026-02-15",
      periodBegin: "2026-02-01",
      periodEnd: "2026-02-14",
      actualGross: "900",
      actualNet: "700",
      taxWithheld: "200",
      verificationStatus: "unverified",
    }, ACTOR));
    expect(pending.linkedTransactions).toBe(1);
    unwrap(await refreshSettlementObligations(pool, { employeeId: employee.id }, ACTOR));
    expect((await getSettlementDashboard(pool)).rows).toHaveLength(0);

    unwrap(await savePayrollCheck(pool, {
      id: pending.id,
      employeeId: employee.id,
      checkNumber: "PENDING-1",
      checkDate: "2026-02-15",
      periodBegin: "2026-02-01",
      periodEnd: "2026-02-14",
      actualGross: "900",
      actualNet: "700",
      taxWithheld: "200",
      verificationStatus: "verified",
    }, ACTOR));
    unwrap(await refreshSettlementObligations(pool, { employeeId: employee.id }, ACTOR));
    const verified = (await getSettlementDashboard(pool)).rows.find((row) => row.kind === "employee_giveback")!;
    expect(verified.originalAmount).toBe("70.0000");

    unwrap(await savePayrollCheck(pool, {
      id: pending.id,
      employeeId: employee.id,
      checkNumber: "PENDING-1",
      checkDate: "2026-02-15",
      periodBegin: "2026-02-01",
      periodEnd: "2026-02-14",
      actualGross: "900",
      actualNet: "700",
      taxWithheld: "200",
      verificationStatus: "unverified",
    }, ACTOR));
    unwrap(await refreshSettlementObligations(pool, { employeeId: employee.id }, ACTOR));
    expect((await getSettlementDashboard(pool)).rows.find((row) => row.id === verified.id)).toMatchObject({
      state: "void",
      balance: "0.0000",
    });
  });

  it("retires an existing obligation through reconciliation when its derived balance becomes zero", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Zero Balance Employee" }, ACTOR));
    unwrap(await saveEmployeeDeal(pool, {
      employeeId: employee.id,
      directRule: "giveback_percent",
      directPercent: "0.10",
      agencyCutPercent: "0",
      effectiveFrom: "2026-01-01",
      reason: "Initial give-back",
    }, ACTOR));
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, check_number, check_date, period_begin, period_end,
          payment_recipient, imported_amount, total_net_pay, transaction_fingerprint)
       VALUES ($1,'ZERO-RETIRE-1','2026-02-15','2026-02-01','2026-02-14',
               'employee','100','100','settle-zero-retire-1')`,
      [employee.id],
    );
    await verifyPayrollCheck({
      employeeId: employee.id,
      checkNumber: "ZERO-RETIRE-1",
      checkDate: "2026-02-15",
      periodBegin: "2026-02-01",
      periodEnd: "2026-02-14",
      actualNet: "100",
    });

    expect(unwrap(await refreshSettlementObligations(pool, { employeeId: employee.id }, ACTOR))).toMatchObject({
      created: 1,
      voided: 0,
    });
    const original = (await getSettlementDashboard(pool)).rows.find((row) => row.checkNumber === "ZERO-RETIRE-1")!;

    unwrap(await saveEmployeeDeal(pool, {
      employeeId: employee.id,
      directRule: "keep_all",
      directPercent: "0",
      agencyCutPercent: "0",
      effectiveFrom: "2026-01-01",
      reason: "Employee now keeps the full check",
    }, ACTOR));
    const refreshed = unwrap(await refreshSettlementObligations(pool, { employeeId: employee.id }, ACTOR));

    expect(refreshed).toMatchObject({ created: 0, updated: 0, adjusted: 0, voided: 1 });
    expect((await getSettlementDashboard(pool)).rows.find((row) => row.id === original.id)).toMatchObject({
      state: "void",
      balance: "0.0000",
    });
  });

  it("reports an ambiguous direct check number without breaking the dashboard query", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Leah Rosen" }, ACTOR));

    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, check_number, check_date, payment_recipient,
          imported_amount, total_net_pay, transaction_fingerprint)
       VALUES
         ($1,'  AMB-1  ','2026-04-01','employee','300','900','settle-ambiguous-check-1'),
         ($1,'  AMB-1  ','2026-04-02','employee','300','900','settle-ambiguous-check-2'),
         ($1,'  AMB-1  ',NULL,'employee','300','900','settle-ambiguous-check-3')`,
      [employee.id],
    );

    const dashboard = await getSettlementDashboard(pool);

    expect(dashboard.checkIssues).toContainEqual(expect.objectContaining({
      sourceId: `${employee.id}:ambiguous-check:AMB-1`,
      employeeId: employee.id,
      employeeName: "Leah Rosen",
      checkNumber: "AMB-1",
      checkDate: "2026-04-01",
      periodBegin: null,
      periodEnd: null,
      transactionCount: 3,
      issue: "conflicting_check_date",
    }));
  });

  it("uses a linked verified check as canonical without hiding unresolved conflicts", async () => {
    const employee = unwrap(await createEmployee(pool, { displayName: "Canonical Check Employee" }, ACTOR));
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, check_number, check_date, period_begin, period_end,
          payment_recipient, imported_amount, total_net_pay, transaction_fingerprint)
       VALUES
         ($1,'VERIFY-1','2026-04-03','2026-04-01','2026-04-15','employee','300','850','verified-source-1'),
         ($1,'VERIFY-1','2026-04-03','2026-04-01','2026-04-15','employee','300','850','verified-source-2'),
         ($1,'VERIFY-1','2026-04-03','2026-04-01','2026-04-15','employee','300','850','verified-source-3')`,
      [employee.id],
    );

    expect((await getSettlementDashboard(pool)).checkIssues.some((issue) =>
      issue.employeeId === employee.id && issue.issue === "missing_net"
    )).toBe(true);

    await pool.query(
      `UPDATE payroll_transactions SET total_net_pay = '800'
        WHERE transaction_fingerprint = 'verified-source-2'`,
    );
    expect((await getSettlementDashboard(pool)).checkIssues.some((issue) =>
      issue.employeeId === employee.id && issue.issue === "conflicting_net"
    )).toBe(true);

    const check = unwrap(await savePayrollCheck(pool, {
      employeeId: employee.id,
      checkNumber: "VERIFY-1",
      checkDate: "2026-04-03",
      periodBegin: "2026-04-01",
      periodEnd: "2026-04-15",
      actualNet: "850",
      verificationStatus: "verified",
    }, ACTOR));
    expect(check.linkedTransactions).toBe(3);

    await pool.query(
      `UPDATE payroll_transactions
          SET check_date = CASE transaction_fingerprint
            WHEN 'verified-source-1' THEN '2026-04-01'::date
            WHEN 'verified-source-2' THEN '2026-04-02'::date
            ELSE NULL
          END
        WHERE payroll_check_id = $1`,
      [check.id],
    );
    expect((await getSettlementDashboard(pool)).checkIssues.filter((issue) =>
      issue.employeeId === employee.id
    )).toEqual([]);

    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, check_number, check_date, payment_recipient,
          imported_amount, total_net_pay, transaction_fingerprint)
       VALUES
         ($1,'UNRESOLVED-1','2026-05-01','employee','300','700','unresolved-source-1'),
         ($1,'UNRESOLVED-1','2026-05-02','employee','300','600','unresolved-source-2'),
         ($1,'UNRESOLVED-1',NULL,'employee','300','700','unresolved-source-3')`,
      [employee.id],
    );
    expect((await getSettlementDashboard(pool)).checkIssues).toContainEqual(expect.objectContaining({
      employeeId: employee.id,
      checkNumber: "UNRESOLVED-1",
      issue: "conflicting_check_date",
    }));
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
    await verifyPayrollCheck({
      employeeId: employee.id,
      checkNumber: "D-2",
      checkDate: "2026-02-01",
      actualNet: "1000",
    });
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
    const homeAgency = await pool.query<{ id: string }>(`SELECT id FROM agencies WHERE is_home_agency = true`);
    await pool.query(
      `INSERT INTO agency_employees (agency_id, employee_id, is_active, effective_from)
       VALUES ($1, $2, true, '2025-01-01')`,
      [homeAgency.rows[0]!.id, target.id],
    );
    await pool.query(
      `INSERT INTO agency_employees
         (agency_id, employee_id, is_active, effective_from, effective_to)
       VALUES ($1, $2, true, '2024-01-01', '2024-12-31')`,
      [homeAgency.rows[0]!.id, source.id],
    );
    await pool.query(
      `INSERT INTO user_employee_access (user_id, employee_id) VALUES ($1, $2), ($1, $3)`,
      [ACTOR, target.id, source.id],
    );
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
    await verifyPayrollCheck({
      employeeId: source.id,
      checkNumber: "MERGE-1",
      checkDate: "2026-03-15",
      actualNet: "1000",
    });

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
      agency_employees: 1,
    });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agency_employees
        WHERE agency_id = $1 AND employee_id = $2`,
      [homeAgency.rows[0]!.id, target.id],
    )).rows[0]?.count).toBe("2");
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM user_employee_access
        WHERE user_id = $1 AND employee_id = $2`,
      [ACTOR, target.id],
    )).rows[0]?.count).toBe("1");

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
    await verifyPayrollCheck({
      employeeId: employee.id,
      checkNumber: "CREDIT-1",
      checkDate: "2026-04-01",
      actualNet: "100",
    });
    await verifyPayrollCheck({
      employeeId: employee.id,
      checkNumber: "CREDIT-2",
      checkDate: "2026-04-15",
      actualNet: "200",
    });
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
    const verifiedCheck = await verifyPayrollCheck({
      employeeId: employee.id,
      checkNumber: "FRESH-1",
      checkDate: "2026-05-01",
      actualNet: "100",
    });

    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    let dashboard = await getSettlementDashboard(pool);
    expect(dashboard.freshness.dirty).toBe(false);
    const obligation = dashboard.rows.find((row) => row.checkNumber === "FRESH-1")!;

    await pool.query(
      `UPDATE employee_payroll_checks SET actual_net = '200', updated_at = now()
        WHERE id = $1`,
      [verifiedCheck.id],
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
