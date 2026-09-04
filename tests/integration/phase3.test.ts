import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testPool, resetSchema, truncateBusinessTables, closeTestPool } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { createIndividual } from "@/lib/manage/individuals";
import { createEmployee } from "@/lib/manage/employees";
import { createAssignment } from "@/lib/manage/assignments";
import { createBudgetPeriod, createAuthorization } from "@/lib/manage/authorizations";
import { createSession } from "@/lib/manage/schedule";
import {
  reconciliationSummary, autoReconcile, manualMatch, unmatchSession,
  candidatesForSession, listBilledNotScheduled, listScheduledForReconcile,
} from "@/lib/manage/reconciliation";
import {
  listCorrectionQueue, correctRowFields, resetRowCorrection, resolveRowMatch,
  setRowReviewStatus, bulkSetStatus, bulkResolveProgram, applyCorrectedImportRow,
} from "@/lib/manage/import-corrections";
import { acceptImportedRate } from "@/lib/manage/rate-exceptions";
import { loadStagingContext } from "@/lib/import/pipeline";
import { stageRows } from "@/lib/import/stage";
import { listImports } from "@/lib/data/app-queries";
import type { AhivimField } from "@/lib/excel/column-map";
import { dec } from "@/lib/money";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

async function scalar<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await testPool().query<Record<string, T>>(sql, params);
  return Object.values(rows[0])[0];
}
const programId = (code: string) => scalar<string>(`SELECT id FROM programs WHERE code = $1`, [code]);
function unwrap<T>(r: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data;
}

/** Insert an actual imported transaction directly (as a commit would). */
async function insertTransaction(opts: {
  individualId: string;
  employeeId?: string;
  programId: string;
  periodBegin: string;
  periodEnd: string;
  hours: string;
  amount: string;
}): Promise<string> {
  const { rows } = await testPool().query<{ id: string }>(
    `INSERT INTO payroll_transactions
       (individual_id, employee_id, program_id, period_begin, period_end,
        imported_hours, imported_amount, transaction_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      opts.individualId,
      opts.employeeId ?? null,
      opts.programId,
      opts.periodBegin,
      opts.periodEnd,
      opts.hours,
      opts.amount,
      `fp-${opts.individualId}-${opts.employeeId ?? "none"}-${opts.periodBegin}-${opts.periodEnd}-${opts.hours}-${Math.random()}`,
    ],
  );
  return rows[0].id;
}

async function insertBatchWithRow(raw: Record<string, unknown>, status = "needs_review"): Promise<{ batchId: string; rowId: string }> {
  const file = await testPool().query<{ id: string }>(
    `INSERT INTO imported_files (original_filename, byte_size, checksum_sha256)
     VALUES ('payroll.xlsx', 1000, $1) RETURNING id`,
    [`sum-${raw.__k ?? Object.values(raw).join("-")}`],
  );
  const batch = await testPool().query<{ id: string }>(
    `INSERT INTO import_batches (imported_file_id, status) VALUES ($1,'staged') RETURNING id`,
    [file.rows[0].id],
  );
  const row = await testPool().query<{ id: string }>(
    `INSERT INTO import_rows (import_batch_id, sheet_name, source_row_number, raw_values, status)
     VALUES ($1,'Sheet1',1,$2::jsonb,$3) RETURNING id`,
    [batch.rows[0].id, JSON.stringify(raw), status],
  );
  return { batchId: batch.rows[0].id, rowId: row.rows[0].id };
}

function validSource(overrides: Partial<Record<AhivimField, string>> = {}): Record<string, unknown> {
  const raw: Record<AhivimField, string> = {
    payTo: "Excellent Staffing",
    checkDate: "2025-08-15",
    checkNumber: "CHK-100",
    code: "RG",
    hours: "2",
    rate: "19",
    amount: "38",
    totalNetPay: "30",
    periodBegin: "2025-08-01",
    periodEnd: "2025-08-15",
    programDescription: "Respit Custom",
    individual: "Aaron Levy",
    employee: "Miriam Klein",
    nonContractHeader: "",
    calculatedInternalAmount: "34",
    dedupNetPayFormula: "",
    paid: "",
    ...overrides,
  };
  return { raw, formulas: {} };
}

async function insertCommittedHeldRow(
  rawValues: Record<string, unknown>,
  ids: { individualId: string; employeeId: string; programId: string },
  sourceRowNumber = 10,
): Promise<{ batchId: string; rowId: string; fileId: string }> {
  const file = await testPool().query<{ id: string }>(
    `INSERT INTO imported_files (original_filename, byte_size, checksum_sha256)
     VALUES ('held.xlsx', 1000, $1) RETURNING id`,
    [`held-${sourceRowNumber}-${Math.random()}`],
  );
  const batch = await testPool().query<{ id: string }>(
    `INSERT INTO import_batches
       (imported_file_id, status, total_rows, skipped_rows,
        source_agency_gross, imported_agency_gross,
        source_internal_amount, imported_internal_amount, reconciliation_notes)
     VALUES ($1,'committed',1,1,'38','0','34','0',
             'Application totals DO NOT agree with the workbook control totals. Investigate before relying on this import.')
     RETURNING id`,
    [file.rows[0].id],
  );
  const row = await testPool().query<{ id: string }>(
    `INSERT INTO import_rows
       (import_batch_id, sheet_name, source_row_number, raw_values, status,
        resolved_individual_id, resolved_employee_id, resolved_program_id)
     VALUES ($1,'Ahivim',$2,$3::jsonb,'needs_review',$4,$5,$6) RETURNING id`,
    [
      batch.rows[0].id,
      sourceRowNumber,
      JSON.stringify(rawValues),
      ids.individualId,
      ids.employeeId,
      ids.programId,
    ],
  );
  await testPool().query(
    `INSERT INTO import_warnings
       (import_batch_id, import_row_id, category, severity, message)
     VALUES ($1,$2,'unknown_program','warning','Map this program')`,
    [batch.rows[0].id, row.rows[0].id],
  );
  return { batchId: batch.rows[0].id, rowId: row.rows[0].id, fileId: file.rows[0].id };
}

suite("phase 3 — reconciliation + import corrections (real PostgreSQL)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role) VALUES ($1,$2,$3,'x','admin')`,
      [ACTOR, "a@a.test", "Admin"],
    );
  });
  afterAll(closeTestPool);

  async function fixture() {
    const dayHab = await programId("DAY_HAB"); // agency 19 / internal 17
    const ind = unwrap(await createIndividual(pool, { displayName: "Aaron Levy" }, ACTOR));
    const emp = unwrap(await createEmployee(pool, { displayName: "Miriam Klein" }, ACTOR));
    unwrap(await createAssignment(pool, { employeeId: emp.id, individualId: ind.id, programId: dayHab }, ACTOR));
    const period = unwrap(await createBudgetPeriod(pool, { individualId: ind.id, label: "FY25", startDate: "2025-01-01", endDate: "2025-12-31" }, ACTOR));
    unwrap(await createAuthorization(pool, { budgetPeriodId: period.id, programId: dayHab, authorizedHours: "100", internalRate: "17" }, ACTOR));
    return { dayHab, ind, emp };
  }

  it("classifies scheduled-not-billed and billed-not-scheduled, then auto-reconciles", async () => {
    const { dayHab, ind, emp } = await fixture();
    const session = unwrap(await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: "2025-03-10", durationHours: "3", startTime: null, endTime: null,
    }, ACTOR));
    await insertTransaction({
      individualId: ind.id,
      employeeId: emp.id,
      programId: dayHab,
      periodBegin: "2025-03-10",
      periodEnd: "2025-03-10",
      hours: "3",
      amount: "51",
    });

    const before = await reconciliationSummary(pool, { from: "2025-03-01", to: "2025-03-31" });
    expect(before.scheduledNotBilled.count).toBe(1);
    expect(before.billedNotScheduled.count).toBe(1);
    expect(before.matched.count).toBe(0);

    const cands = await candidatesForSession(pool, session.id);
    expect(cands).toHaveLength(1);

    const res = unwrap(await autoReconcile(pool, { from: "2025-03-01", to: "2025-03-31" }, ACTOR));
    expect(res.matched).toBe(1);

    const after = await reconciliationSummary(pool, { from: "2025-03-01", to: "2025-03-31" });
    expect(after.matched.count).toBe(1);
    expect(after.scheduledNotBilled.count).toBe(0);
    expect(after.billedNotScheduled.count).toBe(0);
    expect(dec(after.matched.hours).toNumber()).toBe(3);
  });

  it("supports manual match and unmatch, and refuses a double-match", async () => {
    const { dayHab, ind, emp } = await fixture();
    const s1 = unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-04-10", durationHours: "2", startTime: null, endTime: null }, ACTOR));
    const s2 = unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-04-11", durationHours: "2", startTime: null, endTime: null }, ACTOR));
    const tx = await insertTransaction({ individualId: ind.id, programId: dayHab, periodBegin: "2025-04-01", periodEnd: "2025-04-30", hours: "2", amount: "34" });

    unwrap(await manualMatch(pool, s1.id, tx, ACTOR, "obvious"));
    expect(await scalar<string>(`SELECT reconciliation_status FROM scheduled_sessions WHERE id=$1`, [s1.id])).toBe("matched");

    const clash = await manualMatch(pool, s2.id, tx, ACTOR);
    expect(clash.ok).toBe(false);

    unwrap(await unmatchSession(pool, s1.id, ACTOR, "wrong"));
    expect(await scalar<string | null>(`SELECT matched_transaction_id FROM scheduled_sessions WHERE id=$1`, [s1.id])).toBeNull();
    // now s2 can take it
    unwrap(await manualMatch(pool, s2.id, tx, ACTOR));
    expect(await scalar<string>(`SELECT matched_transaction_id FROM scheduled_sessions WHERE id=$1`, [s2.id])).toBe(tx);
  });

  it("rejects manual matches across an individual, program, or service period", async () => {
    const { dayHab, ind, emp } = await fixture();
    const otherIndividual = unwrap(await createIndividual(pool, { displayName: "Other Individual" }, ACTOR));
    const otherProgram = await programId("COM_HAB");
    const session = unwrap(await createSession(pool, {
      employeeId: emp.id,
      programId: dayHab,
      individualIds: [ind.id],
      sessionDate: "2025-04-10",
      durationHours: "2",
      startTime: null,
      endTime: null,
    }, ACTOR));
    const wrongIndividual = await insertTransaction({
      individualId: otherIndividual.id,
      programId: dayHab,
      periodBegin: "2025-04-01",
      periodEnd: "2025-04-30",
      hours: "2",
      amount: "34",
    });
    const wrongProgram = await insertTransaction({
      individualId: ind.id,
      programId: otherProgram,
      periodBegin: "2025-04-01",
      periodEnd: "2025-04-30",
      hours: "2",
      amount: "34",
    });
    const wrongPeriod = await insertTransaction({
      individualId: ind.id,
      programId: dayHab,
      periodBegin: "2025-05-01",
      periodEnd: "2025-05-31",
      hours: "2",
      amount: "34",
    });

    for (const transactionId of [wrongIndividual, wrongProgram, wrongPeriod]) {
      await expect(manualMatch(pool, session.id, transactionId, ACTOR)).resolves.toMatchObject({
        ok: false,
        code: "validation",
      });
    }
    expect(await scalar<string | null>(
      `SELECT matched_transaction_id FROM scheduled_sessions WHERE id = $1`,
      [session.id],
    )).toBeNull();
  });

  it("allows only one winner when two manual matches race for one transaction", async () => {
    const { dayHab, ind, emp } = await fixture();
    const first = unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-04-20", durationHours: "2", startTime: null, endTime: null }, ACTOR));
    const second = unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-04-21", durationHours: "2", startTime: null, endTime: null }, ACTOR));
    const transactionId = await insertTransaction({ individualId: ind.id, programId: dayHab, periodBegin: "2025-04-01", periodEnd: "2025-04-30", hours: "2", amount: "34" });

    const outcomes = await Promise.all([
      manualMatch(pool, first.id, transactionId, ACTOR),
      manualMatch(pool, second.id, transactionId, ACTOR),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({ ok: false, code: "conflict" });
    expect(await scalar<string>(
      `SELECT count(*)::text FROM scheduled_sessions WHERE matched_transaction_id = $1`,
      [transactionId],
    )).toBe("1");
  });

  it("does not auto-match a group session", async () => {
    const { dayHab, emp } = await fixture();
    const a = unwrap(await createIndividual(pool, { displayName: "B One" }, ACTOR));
    const b = unwrap(await createIndividual(pool, { displayName: "B Two" }, ACTOR));
    unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [a.id, b.id], sessionDate: "2025-05-05", durationHours: "4", startTime: null, endTime: null }, ACTOR, "group fixture intentionally lacks setup"));
    await insertTransaction({ individualId: a.id, programId: dayHab, periodBegin: "2025-05-01", periodEnd: "2025-05-31", hours: "4", amount: "68" });
    const res = unwrap(await autoReconcile(pool, { from: "2025-05-01", to: "2025-05-31" }, ACTOR));
    expect(res.matched).toBe(0); // group sessions are skipped
    const billed = await listBilledNotScheduled(pool, { from: "2025-05-01", to: "2025-05-31" });
    expect(billed).toHaveLength(1);
  });

  it("does not auto-match a pay-period aggregate across planned visits", async () => {
    const { dayHab, ind, emp } = await fixture();
    const first = unwrap(await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: "2025-05-12", durationHours: "2", startTime: null, endTime: null,
    }, ACTOR));
    const second = unwrap(await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: "2025-05-13", durationHours: "2", startTime: null, endTime: null,
    }, ACTOR));
    await insertTransaction({
      individualId: ind.id,
      employeeId: emp.id,
      programId: dayHab,
      periodBegin: "2025-05-01",
      periodEnd: "2025-05-31",
      hours: "4",
      amount: "68",
    });

    const result = unwrap(await autoReconcile(pool, { from: "2025-05-01", to: "2025-05-31" }, ACTOR));
    expect(result).toEqual({ matched: 0, considered: 2 });
    const matches = await pool.query<{ id: string }>(
      `SELECT id FROM scheduled_sessions WHERE id = ANY($1::uuid[]) AND matched_transaction_id IS NOT NULL`,
      [[first.id, second.id]],
    );
    expect(matches.rows).toHaveLength(0);
  });

  it("lists scheduled sessions for reconcile with their match state", async () => {
    const { dayHab, ind, emp } = await fixture();
    const s = unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-06-10", durationHours: "2", startTime: null, endTime: null }, ACTOR));
    const lines = await listScheduledForReconcile(pool, { from: "2025-06-01", to: "2025-06-30" }, true);
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe(s.id);
    expect(lines[0].matchedTransactionId).toBeNull();
  });

  it("stores a field correction without touching raw values, and resets it", async () => {
    const { rowId, batchId } = await insertBatchWithRow({ Name: "Aron Levi", Program: "Respit", Hours: "3" });
    unwrap(await correctRowFields(pool, rowId, { Program: "RESPITE", Hours: "3.5" }, ACTOR, "typo in export"));

    const q = await listCorrectionQueue(pool, batchId, {});
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0].raw.Program).toBe("Respit");          // original preserved
    expect((q.rows[0].corrected as Record<string, unknown>).Program).toBe("RESPITE"); // correction stored
    expect(q.rows[0].correctionStatus).toBe("corrected");

    unwrap(await resetRowCorrection(pool, rowId, ACTOR, "revert"));
    const q2 = await listCorrectionQueue(pool, batchId, {});
    expect(q2.rows[0].corrected).toBeNull();
    expect(q2.rows[0].raw.Program).toBe("Respit");         // still intact
  });

  it("resolves a match, changes status, and bulk actions apply", async () => {
    const dayHab = await programId("DAY_HAB");
    const ind = unwrap(await createIndividual(pool, { displayName: "Match Me" }, ACTOR));
    const { rowId, batchId } = await insertBatchWithRow({ Name: "Match Me", __k: "row-a" });
    const second = await insertBatchWithRowInBatch(batchId, { Name: "Also Me", __k: "row-b" });

    unwrap(await resolveRowMatch(pool, rowId, { individualId: ind.id, programId: dayHab }, ACTOR, "confirmed"));
    const q = await listCorrectionQueue(pool, batchId, {});
    const target = q.rows.find((r) => r.id === rowId)!;
    expect(target.resolvedIndividualId).toBe(ind.id);
    expect(target.programName).not.toBeNull();

    const falseImport = await setRowReviewStatus(pool, rowId, "valid", ACTOR, "looks good");
    expect(falseImport.ok).toBe(false);
    expect(await scalar<string>(`SELECT status FROM import_rows WHERE id=$1`, [rowId])).toBe("needs_review");

    const bulk = unwrap(await bulkResolveProgram(pool, batchId, [rowId, second], dayHab, ACTOR, "all respite... day hab"));
    expect(bulk.updated).toBe(2);
    const falseBulkImport = await bulkSetStatus(pool, batchId, [rowId, second], "imported", ACTOR, "not needed");
    expect(falseBulkImport.ok).toBe(false);
    expect(await scalar<string>(`SELECT status FROM import_rows WHERE id=$1`, [second])).toBe("needs_review");
  });

  it("applies a corrected held row atomically, attributes payment, remembers its program alias, and is idempotent", async () => {
    const { dayHab, ind, emp } = await fixture();
    const held = await insertCommittedHeldRow(
      validSource({ programDescription: "Custom Community Day", individual: ind.displayName, employee: emp.displayName }),
      { individualId: ind.id, employeeId: emp.id, programId: dayHab },
    );
    // Historical source facts remain applicable after service ends, provided
    // the people were not archived and the program still exists for posting.
    await testPool().query(`UPDATE individuals SET status='discharged' WHERE id=$1`, [ind.id]);
    await testPool().query(`UPDATE employees SET status='inactive' WHERE id=$1`, [emp.id]);

    const first = unwrap(await applyCorrectedImportRow(pool, held.rowId, ACTOR, {
      rememberProgramAlias: true,
      reason: "Confirmed source row",
    }));
    expect(first.alreadyApplied).toBe(false);
    expect(first.transactionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.serviceSessionId).toMatch(/^[0-9a-f-]{36}$/i);

    const tx = await testPool().query<{
      imported_amount: string;
      calculated_internal_amount: string;
      payment_recipient: string;
      employee_payment_amount: string;
      agency_additional_amount: string;
      service_session_id: string;
    }>(
      `SELECT imported_amount::text, calculated_internal_amount::text, payment_recipient,
              employee_payment_amount::text, agency_additional_amount::text, service_session_id
         FROM payroll_transactions WHERE id = $1`,
      [first.transactionId],
    );
    expect(dec(tx.rows[0].imported_amount).toNumber()).toBe(38);
    expect(dec(tx.rows[0].calculated_internal_amount).toNumber()).toBe(34);
    expect(tx.rows[0].payment_recipient).toBe("excellent_staffing");
    expect(dec(tx.rows[0].employee_payment_amount).toNumber()).toBe(34);
    expect(dec(tx.rows[0].agency_additional_amount).toNumber()).toBe(4);
    expect(tx.rows[0].service_session_id).toBe(first.serviceSessionId);
    expect(await scalar<string>(`SELECT status FROM import_rows WHERE id=$1`, [held.rowId])).toBe("imported");
    expect(await scalar<string>(`SELECT correction_status FROM import_rows WHERE id=$1`, [held.rowId])).toBe("applied");
    expect(Number(await scalar<string>(`SELECT count(*)::text FROM service_allocations WHERE payroll_transaction_id=$1`, [first.transactionId]))).toBe(1);
    expect(Number(await scalar<string>(`SELECT count(*)::text FROM import_warnings WHERE import_row_id=$1 AND resolved_at IS NULL`, [held.rowId]))).toBe(0);
    expect(Number(await scalar<string>(`SELECT imported_rows::text FROM import_batches WHERE id=$1`, [held.batchId]))).toBe(1);
    expect(Number(await scalar<string>(`SELECT count(*)::text FROM program_aliases WHERE normalized_alias='custom community day' AND program_id=$1`, [dayHab]))).toBe(1);
    expect(Number(await scalar<string>(`SELECT count(*)::text FROM audit_logs WHERE action='import_row.applied' AND entity_id=$1`, [held.rowId]))).toBe(1);
    expect(await scalar<string>(`SELECT reconciliation_notes FROM import_batches WHERE id=$1`, [held.batchId])).toContain("agree with");
    expect((await listImports(pool, 100, { reconciliationNeedsReview: true })).some((batch) => batch.batchId === held.batchId)).toBe(false);

    const retry = unwrap(await applyCorrectedImportRow(pool, held.rowId, ACTOR));
    expect(retry.alreadyApplied).toBe(true);
    expect(retry.transactionId).toBe(first.transactionId);
    expect(Number(await scalar<string>(`SELECT count(*)::text FROM payroll_transactions WHERE import_row_id=$1`, [held.rowId]))).toBe(1);

    const editAfterApply = await correctRowFields(pool, held.rowId, { amount: "40" }, ACTOR);
    expect(editAfterApply.ok).toBe(false);
    const rematchAfterApply = await resolveRowMatch(pool, held.rowId, { individualId: ind.id }, ACTOR);
    expect(rematchAfterApply.ok).toBe(false);
    const rawProgram = await scalar<{ raw: Record<string, string> }>(`SELECT raw_values FROM import_rows WHERE id=$1`, [held.rowId]);
    expect(rawProgram.raw.programDescription).toBe("Custom Community Day");
  });

  it("keeps the resolved source identity aligned with the ledger across apply/rematch races", async () => {
    const { dayHab, ind, emp } = await fixture();
    const alternate = unwrap(await createIndividual(pool, { displayName: "Alternate Historical Match" }, ACTOR));
    const held = await insertCommittedHeldRow(
      validSource({ individual: ind.displayName, employee: emp.displayName, checkNumber: "CHK-RACE" }),
      { individualId: ind.id, employeeId: emp.id, programId: dayHab },
      15,
    );

    const [rematch, apply] = await Promise.all([
      resolveRowMatch(pool, held.rowId, { individualId: alternate.id }, ACTOR, "Concurrent rematch"),
      applyCorrectedImportRow(pool, held.rowId, ACTOR, { reason: "Concurrent apply" }),
    ]);
    expect(apply.ok).toBe(true);
    expect(rematch.ok || (!rematch.ok && rematch.code === "immutable")).toBe(true);

    const identity = await testPool().query<{ resolved_individual_id: string; ledger_individual_id: string }>(
      `SELECT r.resolved_individual_id,
              (SELECT t.individual_id FROM payroll_transactions t WHERE t.import_row_id=r.id) AS ledger_individual_id
         FROM import_rows r WHERE r.id=$1`,
      [held.rowId],
    );
    expect(identity.rows[0].resolved_individual_id).toBe(identity.rows[0].ledger_individual_id);
  });

  it("preserves concurrent sparse field corrections and their audit entries", async () => {
    const { dayHab, ind, emp } = await fixture();
    const held = await insertCommittedHeldRow(
      validSource({ individual: ind.displayName, employee: emp.displayName, checkNumber: "CHK-FIELDS" }),
      { individualId: ind.id, employeeId: emp.id, programId: dayHab },
      16,
    );

    const [hours, rate] = await Promise.all([
      correctRowFields(pool, held.rowId, { hours: "3" }, ACTOR, "Correct hours"),
      correctRowFields(pool, held.rowId, { rate: "20" }, ACTOR, "Correct rate"),
    ]);
    expect(hours.ok).toBe(true);
    expect(rate.ok).toBe(true);
    expect(await scalar<Record<string, string>>(
      `SELECT corrected_values FROM import_rows WHERE id=$1`,
      [held.rowId],
    )).toMatchObject({ hours: "3", rate: "20" });
    expect(Number(await scalar<string>(
      `SELECT count(*)::text FROM audit_logs WHERE action='import_row_corrected' AND entity_id=$1`,
      [held.rowId],
    ))).toBe(2);
  });

  it("keeps reconciliation open after a partial correction and clears it after the final held row", async () => {
    const { dayHab, ind, emp } = await fixture();
    const first = await insertCommittedHeldRow(
      validSource({ individual: ind.displayName, employee: emp.displayName, checkNumber: "CHK-201" }),
      { individualId: ind.id, employeeId: emp.id, programId: dayHab },
      40,
    );
    await testPool().query(
      `UPDATE import_batches
          SET total_rows=2, skipped_rows=2,
              source_agency_gross='76', source_internal_amount='68'
        WHERE id=$1`,
      [first.batchId],
    );
    const second = await testPool().query<{ id: string }>(
      `INSERT INTO import_rows
         (import_batch_id, sheet_name, source_row_number, raw_values, status,
          resolved_individual_id, resolved_employee_id, resolved_program_id)
       VALUES ($1,'Ahivim',41,$2::jsonb,'needs_review',$3,$4,$5)
       RETURNING id`,
      [
        first.batchId,
        JSON.stringify(validSource({
          individual: ind.displayName,
          employee: emp.displayName,
          checkNumber: "CHK-202",
        })),
        ind.id,
        emp.id,
        dayHab,
      ],
    );

    unwrap(await applyCorrectedImportRow(pool, first.rowId, ACTOR));
    expect(await scalar<string>(`SELECT reconciliation_notes FROM import_batches WHERE id=$1`, [first.batchId])).toContain("DO NOT agree");
    expect((await listImports(pool, 100, { reconciliationNeedsReview: true })).some((batch) => batch.batchId === first.batchId)).toBe(true);

    unwrap(await applyCorrectedImportRow(pool, second.rows[0].id, ACTOR));
    expect(await scalar<string>(`SELECT reconciliation_notes FROM import_batches WHERE id=$1`, [first.batchId])).toBe("Application totals agree with the workbook control totals.");
    expect((await listImports(pool, 100, { reconciliationNeedsReview: true })).some((batch) => batch.batchId === first.batchId)).toBe(false);
  });

  it("reconciles a corrected row together with a confirmed prior-ledger repeat", async () => {
    const { dayHab, ind, emp } = await fixture();
    const prior = await insertCommittedHeldRow(
      validSource({ individual: ind.displayName, employee: emp.displayName, checkNumber: "CHK-PRIOR" }),
      { individualId: ind.id, employeeId: emp.id, programId: dayHab },
      42,
    );
    unwrap(await applyCorrectedImportRow(pool, prior.rowId, ACTOR));
    const priorFingerprint = await scalar<string>(
      `SELECT transaction_fingerprint FROM payroll_transactions WHERE import_row_id=$1`,
      [prior.rowId],
    );

    const held = await insertCommittedHeldRow(
      validSource({ individual: ind.displayName, employee: emp.displayName, checkNumber: "CHK-CURRENT" }),
      { individualId: ind.id, employeeId: emp.id, programId: dayHab },
      43,
    );
    await testPool().query(
      `INSERT INTO import_rows
         (import_batch_id, sheet_name, source_row_number, raw_values, status, transaction_fingerprint)
       VALUES ($1,'Ahivim',44,$2::jsonb,'duplicate',$3)`,
      [
        held.batchId,
        JSON.stringify(validSource({
          individual: ind.displayName,
          employee: emp.displayName,
          checkNumber: "CHK-PRIOR",
        })),
        priorFingerprint,
      ],
    );
    await testPool().query(
      `UPDATE import_batches
          SET total_rows=2, skipped_rows=2, duplicate_rows=1,
              source_agency_gross='76', source_internal_amount='68'
        WHERE id=$1`,
      [held.batchId],
    );

    unwrap(await applyCorrectedImportRow(pool, held.rowId, ACTOR));

    expect(await scalar<string>(
      `SELECT reconciliation_notes FROM import_batches WHERE id=$1`,
      [held.batchId],
    )).toContain("fully accounted for");
    expect((await listImports(pool, 100, { reconciliationNeedsReview: true }))
      .some((batch) => batch.batchId === held.batchId)).toBe(false);
  });

  it("applies the effective rate on the canonical historical service date", async () => {
    const { dayHab, ind, emp } = await fixture();
    await testPool().query(`DELETE FROM program_rate_schedules WHERE program_id=$1`, [dayHab]);
    await testPool().query(
      `INSERT INTO program_rate_schedules
         (program_id, effective_from, effective_to, agency_rate, internal_rate)
       VALUES ($1,'2024-01-01','2024-12-31','25','17'),
              ($1,'2030-01-01',NULL,'35','22')`,
      [dayHab],
    );
    const held = await insertCommittedHeldRow(
      validSource({
        individual: ind.displayName,
        employee: emp.displayName,
        periodBegin: "2024-06-01",
        checkDate: "2030-06-15",
        periodEnd: "2030-06-30",
        rate: "25",
        amount: "50",
        calculatedInternalAmount: "34",
        checkNumber: "CHK-HISTORICAL",
      }),
      { individualId: ind.id, employeeId: emp.id, programId: dayHab },
      45,
    );

    const applied = unwrap(await applyCorrectedImportRow(pool, held.rowId, ACTOR));
    const rate = await testPool().query<{
      agency_rate_applied: string;
      internal_rate_applied: string;
      calculated_internal_amount: string;
    }>(
      `SELECT agency_rate_applied::text, internal_rate_applied::text,
              calculated_internal_amount::text
         FROM payroll_transactions WHERE id=$1`,
      [applied.transactionId],
    );
    expect(dec(rate.rows[0].agency_rate_applied).toNumber()).toBe(25);
    expect(dec(rate.rows[0].internal_rate_applied).toNumber()).toBe(17);
    expect(dec(rate.rows[0].calculated_internal_amount).toNumber()).toBe(34);
  });

  it("does not let a bulk program correction mutate an imported ledger source", async () => {
    const { dayHab, ind, emp } = await fixture();
    const respite = await programId("RESPITE");
    const held = await insertCommittedHeldRow(
      validSource({ individual: ind.displayName, employee: emp.displayName }),
      { individualId: ind.id, employeeId: emp.id, programId: dayHab },
      50,
    );
    await testPool().query(`UPDATE import_rows SET status='imported' WHERE id=$1`, [held.rowId]);
    await testPool().query(
      `INSERT INTO payroll_transactions
         (import_batch_id, import_row_id, source_file_id, source_row_number,
          individual_id, employee_id, program_id, imported_hours, imported_rate,
          imported_amount, transaction_fingerprint)
       VALUES ($1,$2,$3,50,$4,$5,$6,'2','19','38',$7)`,
      [held.batchId, held.rowId, held.fileId, ind.id, emp.id, dayHab, `locked-${held.rowId}`],
    );

    const result = unwrap(await bulkResolveProgram(
      pool,
      held.batchId,
      [held.rowId],
      respite,
      ACTOR,
      "tampered request must not change imported history",
    ));
    expect(result.updated).toBe(0);
    expect(await scalar<string>(`SELECT resolved_program_id FROM import_rows WHERE id=$1`, [held.rowId])).toBe(dayHab);
    expect(await scalar<string>(`SELECT program_id FROM payroll_transactions WHERE import_row_id=$1`, [held.rowId])).toBe(dayHab);
  });

  it("keeps group-shaped and duplicate rows in attention instead of applying them alone", async () => {
    const { dayHab, ind, emp } = await fixture();
    const other = unwrap(await createIndividual(pool, { displayName: "Group Partner" }, ACTOR));
    const held = await insertCommittedHeldRow(
      validSource({ programDescription: "Day Hab", individual: ind.displayName, employee: emp.displayName }),
      { individualId: ind.id, employeeId: emp.id, programId: dayHab },
      20,
    );
    await testPool().query(
      `INSERT INTO import_rows
         (import_batch_id, sheet_name, source_row_number, raw_values, status,
          resolved_individual_id, resolved_employee_id, resolved_program_id)
       VALUES ($1,'Ahivim',21,$2::jsonb,'needs_review',$3,$4,$5)`,
      [
        held.batchId,
        JSON.stringify(validSource({
          programDescription: "Rematched Custom Program Spelling",
          individual: "Rematched Group Member Spelling",
          employee: "Rematched Worker Spelling",
        })),
        other.id,
        emp.id,
        dayHab,
      ],
    );

    const grouped = await applyCorrectedImportRow(pool, held.rowId, ACTOR);
    expect(grouped.ok).toBe(false);
    if (!grouped.ok) expect(grouped.message).toContain("group session");
    expect(await scalar<string>(`SELECT status FROM import_rows WHERE id=$1`, [held.rowId])).toBe("needs_review");
    expect(Number(await scalar<string>(`SELECT count(*)::text FROM payroll_transactions WHERE import_row_id=$1`, [held.rowId]))).toBe(0);

    await testPool().query(`DELETE FROM import_rows WHERE import_batch_id=$1 AND source_row_number=21`, [held.batchId]);
    await testPool().query(`UPDATE import_rows SET status='duplicate' WHERE id=$1`, [held.rowId]);
    const duplicate = await applyCorrectedImportRow(pool, held.rowId, ACTOR);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.message).toContain("duplicate");
    expect(await scalar<string>(`SELECT status FROM import_rows WHERE id=$1`, [held.rowId])).toBe("duplicate");
  });

  it("accepts an imported rate as an audited decision without editing its transaction", async () => {
    const { dayHab, ind } = await fixture();
    const txId = await insertTransaction({
      individualId: ind.id,
      programId: dayHab,
      periodBegin: "2025-08-01",
      periodEnd: "2025-08-31",
      hours: "2",
      amount: "46",
    });
    const exception = await testPool().query<{ id: string }>(
      `INSERT INTO rate_exceptions
         (payroll_transaction_id, individual_id, program_id, imported_rate,
          expected_rate, variance_amount, variance_percent, direction, note)
       VALUES ($1,$2,$3,'23','17','6','0.352941','higher','Legitimate source rate')
       RETURNING id`,
      [txId, ind.id, dayHab],
    );

    const accepted = unwrap(await acceptImportedRate(pool, exception.rows[0].id, ACTOR, "Confirmed group-priced source"));
    expect(accepted.alreadyAccepted).toBe(false);
    expect(await scalar<string>(`SELECT resolution FROM rate_exceptions WHERE id=$1`, [exception.rows[0].id])).toBe("accepted");
    expect(dec(await scalar<string>(`SELECT imported_amount::text FROM payroll_transactions WHERE id=$1`, [txId])).toNumber()).toBe(46);
    expect(Number(await scalar<string>(`SELECT count(*)::text FROM audit_logs WHERE action='rate_exception.accepted' AND entity_id=$1`, [exception.rows[0].id]))).toBe(1);
    expect(unwrap(await acceptImportedRate(pool, exception.rows[0].id, ACTOR)).alreadyAccepted).toBe(true);
  });

  it("uses approved database program aliases during future staging", async () => {
    const { dayHab, ind, emp } = await fixture();
    await testPool().query(
      `INSERT INTO program_aliases (program_id, normalized_alias, source_text, status)
       VALUES ($1,'custom day supports','Custom Day Supports','approved')`,
      [dayHab],
    );
    const context = await loadStagingContext(pool);
    const stored = validSource({
      programDescription: "Custom Day Supports",
      individual: ind.displayName,
      employee: emp.displayName,
    }) as { raw: Record<AhivimField, string> };
    const staged = stageRows([{
      sourceRowNumber: 30,
      raw: stored.raw,
      formulas: {},
      parsed: stored.raw,
      errors: [],
    }], context);
    expect(staged.rows[0].status).toBe("valid");
    expect(staged.rows[0].programCode).toBe("DAY_HAB");
    expect(staged.warnings.some((warning) => warning.category === "unknown_program")).toBe(false);
  });

  // helper that adds another row to an existing batch
  async function insertBatchWithRowInBatch(batchId: string, raw: Record<string, unknown>): Promise<string> {
    const row = await testPool().query<{ id: string }>(
      `INSERT INTO import_rows (import_batch_id, sheet_name, source_row_number, raw_values, status)
       VALUES ($1,'Sheet1',2,$2::jsonb,'needs_review') RETURNING id`,
      [batchId, JSON.stringify(raw)],
    );
    return row.rows[0].id;
  }
});
