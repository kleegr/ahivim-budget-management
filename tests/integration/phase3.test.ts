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
  setRowReviewStatus, bulkSetStatus, bulkResolveProgram,
} from "@/lib/manage/import-corrections";
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
  individualId: string; programId: string; periodBegin: string; periodEnd: string; hours: string; amount: string;
}): Promise<string> {
  const { rows } = await testPool().query<{ id: string }>(
    `INSERT INTO payroll_transactions
       (individual_id, program_id, period_begin, period_end, imported_hours, imported_amount, transaction_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [opts.individualId, opts.programId, opts.periodBegin, opts.periodEnd, opts.hours, opts.amount,
     `fp-${opts.individualId}-${opts.periodBegin}-${opts.periodEnd}-${opts.hours}`],
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
    await insertTransaction({ individualId: ind.id, programId: dayHab, periodBegin: "2025-03-01", periodEnd: "2025-03-15", hours: "3", amount: "51" });

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

    unwrap(await setRowReviewStatus(pool, rowId, "valid", ACTOR, "looks good"));
    expect(await scalar<string>(`SELECT status FROM import_rows WHERE id=$1`, [rowId])).toBe("valid");

    const bulk = unwrap(await bulkResolveProgram(pool, batchId, [rowId, second], dayHab, ACTOR, "all respite... day hab"));
    expect(bulk.updated).toBe(2);
    const bulkStatus = unwrap(await bulkSetStatus(pool, batchId, [rowId, second], "skipped", ACTOR, "not needed"));
    expect(bulkStatus.updated).toBe(2);
    expect(await scalar<string>(`SELECT status FROM import_rows WHERE id=$1`, [second])).toBe("skipped");
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
