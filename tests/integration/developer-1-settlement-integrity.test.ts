import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { PgLikePool } from "@/lib/import/commit";
import { savePayrollCheck, syncImportedPayrollCheckReviews } from "@/lib/manage/direct-pay-operations";
import { saveEmployeeDeal } from "@/lib/manage/employee-deals";
import { createIndividual } from "@/lib/manage/individuals";
import { createStrategy, updateStrategy } from "@/lib/manage/calculation-strategies";
import { getSettlementDashboard } from "@/lib/data/settlements";
import { directEmployeeSummaries } from "@/lib/data/portal-direct-read-model";
import { getEmployeeMoneyProfile } from "@/lib/data/employee-profile";
import type { PortalAccessContext } from "@/lib/auth/portal-access";
import {
  applySettlementCredit,
  correctSettlementEvent,
  recordObligationPayment,
  refreshSettlementObligations,
  refundSettlementCredit,
  reverseSettlementEvent,
  settleObligations,
} from "@/lib/manage/settlements";
import { getSettlementLedgerFreshness, settlementApplicationDate } from "@/lib/manage/settlement-freshness";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
const key = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
let pool: PgLikePool;
let employeeId: string;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
}

/** Ensure both real transactions observe the absent key before either takes the source lock. */
function concurrentReplayPool(): PgLikePool {
  let arrivals = 0;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  return {
    query: (sql, params) => pool.query(sql, params),
    connect: async () => {
      const client = await pool.connect();
      let firstLookup = true;
      return {
        query: async (sql, params) => {
          const result = await client.query(sql, params);
          if (firstLookup && sql.includes("FROM settlement_batches") && sql.includes("WHERE idempotency_key")) {
            firstLookup = false;
            arrivals++;
            if (arrivals === 2) releaseBarrier();
            await barrier;
          }
          return result;
        },
        release: (error) => client.release(error),
      } as Awaited<ReturnType<PgLikePool["connect"]>>;
    },
  };
}

async function payment() {
  const obligation = await pool.query<{ id: string }>(
    `INSERT INTO settlement_obligations
       (source_key, kind, direction, employee_id, original_amount)
     VALUES ('concurrent-retry-root', 'employee_giveback', 'receivable', $1, 100)
     RETURNING id`,
    [employeeId],
  );
  // This synthetic fixture has no changing calculation sources. Certify the
  // current source version so money operations exercise their normal gates.
  await pool.query(
    `UPDATE settlement_ledger_state
        SET refreshed_version = source_version, refreshed_for_date = $1::date,
            dirty_since = NULL, last_refresh_error = NULL WHERE singleton = true`,
    [settlementApplicationDate()],
  );
  const result = unwrap(await recordObligationPayment(pool, {
    obligationId: obligation.rows[0].id,
    amount: "35.1250",
    occurredOn: "2026-08-21",
    operationKey: key(1),
  }, ACTOR));
  return { obligationId: obligation.rows[0].id, eventId: result.eventIds[0] };
}

async function agencySources() {
  const other = await pool.query<{ id: string }>(
    `INSERT INTO employees (normalized_name, display_name)
     VALUES ('synthetic known employee', 'Synthetic Known Employee') RETURNING id`,
  );
  for (const id of [employeeId, other.rows[0].id]) {
    unwrap(await saveEmployeeDeal(pool, {
      employeeId: id, directRule: "giveback_percent", directPercent: "0.10",
      agencyCutPercent: "0.10", effectiveFrom: "2026-01-01", reason: "Synthetic confirmed agreement",
    }, ACTOR));
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, check_date, payment_recipient, imported_amount,
          calculated_internal_amount, transaction_fingerprint)
       VALUES ($1, '2026-08-21', 'excellent_staffing', 125, 100, $2)`,
      [id, `synthetic-known-${id}`],
    );
  }
  unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
  const dashboard = await getSettlementDashboard(pool);
  const held = dashboard.rows.find((row) => row.personId === employeeId)!;
  const known = dashboard.rows.find((row) => row.personId === other.rows[0].id)!;
  expect(held.originalAmount).toBe("90.0000");
  expect(known.originalAmount).toBe("90.0000");
  return { held, known };
}

suite("Developer 1 settlement integrity regressions (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES ($1, 'operator@example.test', 'Operator', 'x', 'admin')`, [ACTOR],
    );
    const employee = await pool.query<{ id: string }>(
      `INSERT INTO employees (normalized_name, display_name)
       VALUES ('synthetic settlement employee', 'Synthetic Settlement Employee') RETURNING id`,
    );
    employeeId = employee.rows[0].id;
  });
  afterAll(closeTestPool);

  it.each([
    { periodBegin: "2026-08-01", periodEnd: "2026-08-14" },
    { periodEnd: "2026-08-14" },
  ])("honors a supplied check date when only period coordinates identify the check: %j", async (period) => {
    const source = await pool.query<{ id: string; transaction_fingerprint: string }>(
      `INSERT INTO payroll_transactions
         (employee_id, check_date, period_begin, period_end, payment_recipient, imported_amount, transaction_fingerprint)
       VALUES
         ($1, '2026-08-15', '2026-08-01', '2026-08-14', 'employee', 500, 'intended-check'),
         ($1, '2026-08-22', '2026-08-01', '2026-08-14', 'employee', 700, 'different-check'),
         ($1, '2026-08-15', '2026-08-01', '2026-08-14', 'excellent_staffing', 800, 'agency-source')
       RETURNING id, transaction_fingerprint`, [employeeId],
    );
    const check = unwrap(await savePayrollCheck(pool, {
      employeeId, checkDate: "2026-08-15", ...period,
      actualGross: "500", actualNet: "420", verificationStatus: "verified",
    }, ACTOR));
    expect(check.linkedTransactions).toBe(1);
    const links = await pool.query<{ id: string }>(
      `SELECT id FROM payroll_transactions WHERE payroll_check_id = $1`, [check.id],
    );
    expect(links.rows.map((row) => row.id)).toEqual([
      source.rows.find((row) => row.transaction_fingerprint === "intended-check")!.id,
    ]);
  });

  it("replays two simultaneous corrections without a false conflict or duplicate money", async () => {
    const original = await payment();
    const concurrent = concurrentReplayPool();
    const input = {
      amount: "30.0625", occurredOn: "2026-08-22",
      reason: "Verified corrected receipt", operationKey: key(2),
    };
    const results = await Promise.all([
      correctSettlementEvent(concurrent, original.eventId, input, ACTOR),
      correctSettlementEvent(concurrent, original.eventId, input, ACTOR),
    ]);
    const first = unwrap(results[0]);
    expect(unwrap(results[1])).toEqual(first);
    const activity = await pool.query<{ count: string; applied: string }>(
      `SELECT count(*)::text AS count, sum(amount)::text AS applied
         FROM settlement_events WHERE settlement_obligation_id = $1`, [original.obligationId],
    );
    expect(activity.rows[0]).toEqual({ count: "3", applied: "30.0625" });
    const different = await correctSettlementEvent(pool, original.eventId, { ...input, amount: "31" }, ACTOR);
    expect(different).toMatchObject({ ok: false, code: "conflict" });
    // Correcting the replacement preserves both earlier versions in history.
    const replacement = await pool.query<{ id: string }>(
      `SELECT id FROM settlement_events WHERE settlement_batch_id = $1 AND event_type = 'payment'`, [first.batchId],
    );
    unwrap(await correctSettlementEvent(pool, replacement.rows[0].id, {
      ...input, amount: "29.9375", operationKey: key(3),
    }, ACTOR));
    const chain = await pool.query<{ count: string; applied: string }>(
      `SELECT count(*)::text AS count, sum(amount)::text AS applied
         FROM settlement_events WHERE settlement_obligation_id = $1`, [original.obligationId],
    );
    expect(chain.rows[0]).toEqual({ count: "5", applied: "29.9375" });
  });

  it("replays two simultaneous reversals and preserves the original recorded payment", async () => {
    const original = await payment();
    const concurrent = concurrentReplayPool();
    const results = await Promise.all([
      reverseSettlementEvent(concurrent, original.eventId, "Receipt reversed", ACTOR, key(4)),
      reverseSettlementEvent(concurrent, original.eventId, "Receipt reversed", ACTOR, key(4)),
    ]);
    expect(unwrap(results[1])).toEqual(unwrap(results[0]));
    const activity = await pool.query<{ count: string; applied: string; payments: string }>(
      `SELECT count(*)::text AS count, sum(amount)::text AS applied,
              count(*) FILTER (WHERE event_type = 'payment')::text AS payments
         FROM settlement_events WHERE settlement_obligation_id = $1`, [original.obligationId],
    );
    expect(activity.rows[0]).toEqual({ count: "2", applied: "0.0000", payments: "1" });
  });

  it("holds missing-rule roots and their corrections while other employees remain usable", async () => {
    const { held, known } = await agencySources();
    const paid = unwrap(await recordObligationPayment(pool, {
      obligationId: held.id, amount: "95", occurredOn: "2026-08-22", operationKey: key(10),
    }, ACTOR));
    // A confirmed backdated change creates an auditable delta from the actioned
    // 90.00 obligation, rather than rewriting its original amount.
    unwrap(await saveEmployeeDeal(pool, {
      employeeId, directRule: "giveback_percent", directPercent: "0.10",
      agencyCutPercent: "0.20", effectiveFrom: "2026-01-01", reason: "Corrected synthetic agreement",
    }, ACTOR));
    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    const beforeReview = await getSettlementDashboard(pool);
    const correction = beforeReview.rows.find((row) => row.personId === employeeId && row.kind.endsWith("_correction"))!;
    expect(correction).toMatchObject({ direction: "receivable", originalAmount: "10.0000" });
    await pool.query(`UPDATE employee_deals SET status = 'archived', archived_at = now(), archived_by_user_id = $2 WHERE employee_id = $1`, [employeeId, ACTOR]);
    const refreshed = unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    expect(refreshed).toMatchObject({ skippedNoDeal: 1, reviewRequiredCount: 1 });
    expect(await getSettlementLedgerFreshness(pool)).toMatchObject({ dirty: false, sourceReviewCount: 1 });
    const dashboard = await getSettlementDashboard(pool);
    expect(dashboard.rows.find((row) => row.id === held.id)).toMatchObject({
      originalAmount: "90.0000", appliedAmount: "95.0000", reviewRequired: true,
    });
    expect(dashboard.rows.find((row) => row.id === correction.id)?.reviewRequired).toBe(true);
    expect(dashboard.events.find((row) => row.id === paid.eventIds[0])?.reviewRequired).toBe(true);
    expect(dashboard.rows.find((row) => row.id === known.id)?.reviewRequired).toBe(false);
    expect(dashboard.summary).toMatchObject({ agencyOwes: "90.0000", employeesOwe: "0.0000", credits: "0.0000", appliedTotal: "95.0000" });

    const guarded = await Promise.all([
      recordObligationPayment(pool, { obligationId: held.id, amount: "1", occurredOn: "2026-08-22", operationKey: key(11) }, ACTOR),
      recordObligationPayment(pool, { obligationId: correction.id, amount: "1", occurredOn: "2026-08-22", operationKey: key(12) }, ACTOR),
      settleObligations(pool, { obligationIds: [held.id, known.id], occurredOn: "2026-08-22", operationKey: key(13) }, ACTOR),
      refundSettlementCredit(pool, { obligationId: held.id, amount: "1", occurredOn: "2026-08-22", operationKey: key(14) }, ACTOR),
      correctSettlementEvent(pool, paid.eventIds[0], { amount: "94", occurredOn: "2026-08-22", reason: "Synthetic correction", operationKey: key(15) }, ACTOR),
      reverseSettlementEvent(pool, paid.eventIds[0], "Synthetic reversal", ACTOR, key(16)),
      applySettlementCredit(pool, { sourceObligationId: held.id, targetObligationId: known.id, amount: "1", occurredOn: "2026-08-22", operationKey: key(17) }, ACTOR),
    ]);
    for (const result of guarded) expect(result).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("source review") });
    await expect(pool.query(
      `INSERT INTO settlement_events (settlement_obligation_id, employee_id, event_type, amount, occurred_on)
       VALUES ($1, $2, 'payment', 1, '2026-08-22')`, [held.id, employeeId],
    )).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("source review") });
    expect((await getSettlementDashboard(pool)).events).toHaveLength(1);
    unwrap(await recordObligationPayment(pool, {
      obligationId: known.id, amount: "12.3456", occurredOn: "2026-08-22", operationKey: key(18),
    }, ACTOR));

    // Even an unrelated source edit expires the whole processed-version
    // certificate. No operation may use the prior balances before refresh.
    await pool.query(`UPDATE payroll_transactions SET imported_amount = 126 WHERE employee_id = $1`, [known.personId]);
    expect(await getSettlementLedgerFreshness(pool)).toMatchObject({ dirty: true });
    expect(await recordObligationPayment(pool, {
      obligationId: known.id, amount: "1", occurredOn: "2026-08-22", operationKey: key(19),
    }, ACTOR)).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("out of date") });
    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    unwrap(await recordObligationPayment(pool, {
      obligationId: known.id, amount: "1", occurredOn: "2026-08-22", operationKey: key(19),
    }, ACTOR));
  });

  it("preserves a previously actioned verified check when verification is withdrawn", async () => {
    unwrap(await saveEmployeeDeal(pool, {
      employeeId, directRule: "giveback_percent", directPercent: "0.10",
      agencyCutPercent: "0", effectiveFrom: "2026-01-01", reason: "Synthetic verified agreement",
    }, ACTOR));
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, check_date, check_number, payment_recipient, imported_amount, transaction_fingerprint)
       VALUES ($1, '2026-08-21', 'VERIFIED-SOURCE', 'employee', 100, 'verification-review-source')`, [employeeId],
    );
    const checkInput = {
      employeeId, checkDate: "2026-08-21", checkNumber: "VERIFIED-SOURCE", actualGross: "100", actualNet: "80",
    };
    const check = unwrap(await savePayrollCheck(pool, { ...checkInput, verificationStatus: "verified" }, ACTOR));
    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    const obligation = (await getSettlementDashboard(pool)).rows[0];
    expect(obligation.originalAmount).toBe("8.0000");
    unwrap(await recordObligationPayment(pool, {
      obligationId: obligation.id, amount: "2", occurredOn: "2026-08-22", operationKey: key(20),
    }, ACTOR));
    unwrap(await savePayrollCheck(pool, { ...checkInput, id: check.id, verificationStatus: "unverified" }, ACTOR));
    const portalContext: PortalAccessContext = {
      userId: ACTOR, globalRoles: [{ role: "employee", grants: [], denials: [] }],
      individualLinks: [], agencyAccess: [],
      employeeLinks: [{ employeeId, relationship: "self", grants: [], denials: [] }],
    };
    // Withdrawing check verification immediately removes its current due from
    // portal totals, even before the next refresh processes the source change.
    const portal = await directEmployeeSummaries(pool, portalContext, "2026-08");
    expect(portal[0].giveBack).toMatchObject({ dueThisMonth: "0.0000", remaining: "0.0000", collectedThisMonth: "2.0000" });
    const profile = await getEmployeeMoneyProfile(pool, employeeId);
    expect(profile.roots).toHaveLength(0);
    expect(profile.events).toHaveLength(1);
    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    const dashboard = await getSettlementDashboard(pool);
    expect(dashboard.rows).toHaveLength(1);
    expect(dashboard.rows[0]).toMatchObject({ id: obligation.id, originalAmount: "8.0000", appliedAmount: "2.0000", reviewRequired: true });
    expect(dashboard.freshness).toMatchObject({ dirty: false, sourceReviewCount: 1 });
    unwrap(await savePayrollCheck(pool, { ...checkInput, id: check.id, verificationStatus: "verified" }, ACTOR));
    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    expect((await getSettlementDashboard(pool)).rows[0]).toMatchObject({ id: obligation.id, reviewRequired: false });
    expect((await directEmployeeSummaries(pool, portalContext, "2026-08"))[0].giveBack).toMatchObject({
      dueThisMonth: "8.0000", remaining: "6.0000", collectedThisMonth: "2.0000",
    });
  });

  it("holds unknown active Financial Setup without manufacturing dates or a zero correction", async () => {
    const individual = unwrap(await createIndividual(pool, { displayName: "Synthetic Financial Setup Person" }, ACTOR));
    const strategy = unwrap(await createStrategy(pool, { individualId: individual.id }, ACTOR));
    unwrap(await updateStrategy(pool, { id: strategy.id, afterAll: "40", renewalDate: "2026-08-01" }, ACTOR));
    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    const obligation = (await getSettlementDashboard(pool)).rows[0];
    unwrap(await recordObligationPayment(pool, {
      obligationId: obligation.id, amount: "40", occurredOn: "2026-08-22", operationKey: key(21),
    }, ACTOR));
    unwrap(await updateStrategy(pool, { id: strategy.id, renewalDate: null }, ACTOR, "Source date requires review"));
    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    const dashboard = await getSettlementDashboard(pool);
    expect(dashboard.rows).toHaveLength(1);
    expect(dashboard.rows[0]).toMatchObject({ id: obligation.id, originalAmount: obligation.originalAmount, appliedAmount: "40.0000", reviewRequired: true });
    expect(dashboard.freshness).toMatchObject({ dirty: false, sourceReviewCount: 1 });
    const setup = await pool.query<{ renewal_date: string | null }>(`SELECT renewal_date FROM calculation_strategies WHERE id = $1`, [strategy.id]);
    expect(setup.rows[0].renewal_date).toBeNull();
  });

  it("holds mixed-source snapshots and legacy missing provenance before recalculating them", async () => {
    const { held, known } = await agencySources();
    const unresolved = await pool.query<{ id: string }>(
      `INSERT INTO payroll_transactions
         (employee_id, check_date, payment_recipient, imported_amount, transaction_fingerprint)
       VALUES ($1, '2026-08-21', 'excellent_staffing', 75, 'missing-base-mixed-source') RETURNING id`, [employeeId],
    );
    await pool.query(
      `INSERT INTO settlement_obligation_transactions (settlement_obligation_id, payroll_transaction_id, allocated_amount)
       VALUES ($1, $2, NULL)`, [held.id, unresolved.rows[0].id],
    );
    const legacy = await pool.query<{ id: string }>(
      `INSERT INTO settlement_obligations (source_key, kind, direction, employee_id, original_amount, calculation_metadata)
       VALUES ('legacy-unmapped-source', 'employee_payout', 'payable', $1, 25, '{"flow":"agency_routed"}'::jsonb) RETURNING id`, [employeeId],
    );
    const foreignSource = await pool.query<{ id: string }>(`SELECT id FROM payroll_transactions WHERE employee_id = $1`, [known.personId]);
    const foreignLegacy = await pool.query<{ id: string }>(
      `INSERT INTO settlement_obligations (source_key, kind, direction, employee_id, original_amount, calculation_metadata)
       VALUES ('legacy-foreign-provenance', 'employee_payout', 'payable', $1, 35,
               jsonb_build_object('flow', 'agency_routed', 'sourceTransactionIds', jsonb_build_array($2::text))) RETURNING id`,
      [employeeId, foreignSource.rows[0].id],
    );
    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    const dashboard = await getSettlementDashboard(pool);
    expect(dashboard.rows.find((row) => row.id === held.id)).toMatchObject({ reviewRequired: true, originalAmount: "90.0000", transactionCount: 2 });
    expect(dashboard.rows.find((row) => row.id === legacy.rows[0].id)).toMatchObject({ reviewRequired: true, originalAmount: "25.0000", state: "open" });
    expect(dashboard.rows.find((row) => row.id === known.id)?.reviewRequired).toBe(false);
    expect(dashboard.rows.find((row) => row.id === foreignLegacy.rows[0].id)).toMatchObject({ reviewRequired: true, originalAmount: "35.0000", state: "open" });
    expect(dashboard.summary.agencyOwes).toBe("90.0000");
  });

  it("cannot reverse either half of a transferred credit while its peer balance requires review", async () => {
    unwrap(await saveEmployeeDeal(pool, {
      employeeId, directRule: "giveback_percent", directPercent: "0.10", agencyCutPercent: "0",
      effectiveFrom: "2026-01-01", reason: "Synthetic credit agreement",
    }, ACTOR));
    const checks = [];
    for (const [number, amount] of [["CREDIT-SOURCE", "100"], ["CREDIT-TARGET", "200"]]) {
      await pool.query(
        `INSERT INTO payroll_transactions
           (employee_id, check_date, check_number, payment_recipient, imported_amount, transaction_fingerprint)
         VALUES ($1, '2026-08-21', $2, 'employee', $3, $2)`, [employeeId, number, amount],
      );
      checks.push(unwrap(await savePayrollCheck(pool, {
        employeeId, checkDate: "2026-08-21", checkNumber: number, actualGross: amount,
        actualNet: amount, verificationStatus: "verified",
      }, ACTOR)));
    }
    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    const rows = (await getSettlementDashboard(pool)).rows;
    const source = rows.find((row) => row.checkNumber === "CREDIT-SOURCE")!;
    const target = rows.find((row) => row.checkNumber === "CREDIT-TARGET")!;
    unwrap(await recordObligationPayment(pool, {
      obligationId: source.id, amount: "15", occurredOn: "2026-08-22", operationKey: key(30),
    }, ACTOR));
    const credit = unwrap(await applySettlementCredit(pool, {
      sourceObligationId: source.id, targetObligationId: target.id, amount: "5",
      occurredOn: "2026-08-22", operationKey: key(31),
    }, ACTOR));
    unwrap(await savePayrollCheck(pool, {
      id: checks[1].id, employeeId, checkDate: "2026-08-21", checkNumber: "CREDIT-TARGET",
      actualGross: "200", actualNet: "200", verificationStatus: "unverified",
    }, ACTOR));
    unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    for (const [index, eventId] of credit.eventIds.entries()) {
      expect(await reverseSettlementEvent(pool, eventId, "Review peer", ACTOR, key(32 + index))).toMatchObject({
        ok: false, code: "conflict", message: expect.stringContaining("source review"),
      });
    }
    // A previous application version does not know reviewRequired. The
    // database must also reject reversing the clear side of a held transfer.
    await expect(pool.query(
      `INSERT INTO settlement_events
         (settlement_obligation_id, employee_id, event_type, amount, occurred_on, reversal_of_event_id)
       SELECT settlement_obligation_id, employee_id, 'reversal', -amount, '2026-08-22', id
         FROM settlement_events WHERE settlement_batch_id = $1 AND settlement_obligation_id = $2`,
      [credit.batchId, source.id],
    )).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("source review") });
    const dashboard = await getSettlementDashboard(pool);
    expect(dashboard.events).toHaveLength(3);
    expect(dashboard.rows.find((row) => row.id === source.id)).toMatchObject({ appliedAmount: "10.0000", reviewRequired: false });
    expect(dashboard.rows.find((row) => row.id === target.id)).toMatchObject({ appliedAmount: "5.0000", reviewRequired: true });
    expect(dashboard.events.filter((row) => row.eventType === "credit").every((row) => row.reviewRequired)).toBe(true);
  });

  it("preserves a detached unverified check snapshot without generating a refund", async () => {
    const check = unwrap(await savePayrollCheck(pool, {
      employeeId, checkNumber: "DETACHED-REVIEW", checkDate: "2026-08-21",
      actualGross: "100", actualNet: "80", verificationStatus: "unverified",
    }, ACTOR));
    const obligation = await pool.query<{ id: string }>(
      `INSERT INTO settlement_obligations
         (source_key, kind, direction, employee_id, original_amount, calculation_metadata)
       VALUES ('detached-review-root', 'employee_giveback', 'receivable', $1, 8,
               jsonb_build_object('flow', 'direct_employee', 'payrollCheckId', $2::text)) RETURNING id`,
      [employeeId, check.id],
    );
    await pool.query(
      `INSERT INTO settlement_events (settlement_obligation_id, employee_id, event_type, amount, occurred_on)
       VALUES ($1, $2, 'payment', 2, '2026-08-22')`, [obligation.rows[0].id, employeeId],
    );
    const refresh = unwrap(await refreshSettlementObligations(pool, {}, ACTOR));
    expect(refresh).toMatchObject({ adjusted: 0, voided: 0, reviewRequiredCount: 1 });
    const dashboard = await getSettlementDashboard(pool);
    expect(dashboard.rows).toHaveLength(1);
    expect(dashboard.rows[0]).toMatchObject({ reviewRequired: true, originalAmount: "8.0000", appliedAmount: "2.0000" });
    expect(await recordObligationPayment(pool, {
      obligationId: obligation.rows[0].id, amount: "1", occurredOn: "2026-08-22", operationKey: key(40),
    }, ACTOR)).toMatchObject({ ok: false, code: "conflict", message: expect.stringContaining("source review") });
  });

  it("does not manufacture an imported check from batch-local NET when the same identity conflicts historically", async () => {
    const file = await pool.query<{ id: string }>(
      `INSERT INTO imported_files (original_filename, byte_size, checksum_sha256)
       VALUES ('synthetic-cross-batch.xlsx', 1, 'synthetic-cross-batch-checks') RETURNING id`,
    );
    const batches = await pool.query<{ id: string }>(
      `INSERT INTO import_batches (imported_file_id, status) VALUES ($1, 'committed'), ($1, 'committed') RETURNING id`,
      [file.rows[0].id],
    );
    await pool.query(
      `INSERT INTO payroll_transactions
         (employee_id, import_batch_id, check_date, check_number, payment_recipient,
          imported_amount, total_net_pay, transaction_fingerprint)
       VALUES
         ($1, $2, '2026-08-21', 'CONFLICT-NET', 'employee', 500, 400, 'historical-check-net'),
         ($1, $3, '2026-08-21', 'CONFLICT-NET', 'employee', 500, 450, 'current-conflicting-net'),
         ($1, $3, '2026-08-21', 'CLEAN-NET', 'employee', 200, 180, 'current-clean-net')`,
      [employeeId, batches.rows[0].id, batches.rows[1].id],
    );
    expect(await syncImportedPayrollCheckReviews(pool, batches.rows[1].id, ACTOR)).toEqual({ checks: 1, linkedTransactions: 1 });
    expect(await syncImportedPayrollCheckReviews(pool, batches.rows[1].id, ACTOR)).toEqual({ checks: 0, linkedTransactions: 0 });
    const checks = await pool.query<{ check_number: string; actual_net: string }>(
      `SELECT check_number, actual_net::text FROM employee_payroll_checks WHERE employee_id = $1`, [employeeId],
    );
    expect(checks.rows).toEqual([{ check_number: "CLEAN-NET", actual_net: "180.0000" }]);
    const conflicts = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payroll_transactions
        WHERE check_number = 'CONFLICT-NET' AND payroll_check_id IS NULL`,
    );
    expect(conflicts.rows[0].count).toBe("2");
  });

  it("upgrades existing settlement history without modifying its money or audit snapshots", async () => {
    await payment();
    const snapshots = () => pool.query<{ obligations: unknown; events: unknown }>(
      `SELECT (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM settlement_obligations o) AS obligations,
              (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM settlement_events e) AS events`,
    );
    const before = await snapshots();
    // Recreate the pre-0045 schema only in this explicitly disposable database.
    await pool.query(`DROP TRIGGER IF EXISTS settlement_events_source_review_guard ON settlement_events`);
    await pool.query(`ALTER TABLE settlement_ledger_state DROP COLUMN blocked_obligation_ids,
      DROP COLUMN source_review_count, DROP COLUMN source_review_summary`);
    const migration = readFileSync("drizzle/0045_settlement_source_review.sql", "utf8");
    for (const statement of migration.split("--> statement-breakpoint").filter((sql) => sql.trim())) {
      await pool.query(statement);
    }
    expect((await snapshots()).rows).toEqual(before.rows);
    expect(await getSettlementLedgerFreshness(pool)).toMatchObject({ dirty: true, sourceReviewCount: 0 });
  });
});
