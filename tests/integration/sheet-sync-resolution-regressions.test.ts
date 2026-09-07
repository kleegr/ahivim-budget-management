import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import type { SheetSyncConfig } from "@/lib/sheets/config";
import type { CsvFetcher } from "@/lib/sheets/fetch";
import { listOpenConflicts } from "@/lib/sheets/queries";
import { applyChangedConflict, dismissConflict } from "@/lib/sheets/resolve";
import { runSheetSync } from "@/lib/sheets/sync";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
let pool: PgLikePool;

const CONFIG: SheetSyncConfig = {
  enabled: true,
  sheetId: "TEST_SHEET",
  sheetName: "Ahivim",
  scheduleHourUtc: 8,
  minIntervalMinutes: 60,
};

interface Row {
  payTo: string;
  checkNumber: string;
  hours: string;
  rate: string;
  amount: string;
  totalNetPay: string;
  program: string;
  individual: string;
  employee: string;
  internal?: string;
  paid?: string;
}

const BASE: Row = {
  payTo: "Excellent Staffing",
  checkNumber: "9101",
  hours: "10",
  rate: "25",
  amount: "250",
  totalNetPay: "225",
  program: "Com Hab",
  individual: "Regression Person",
  employee: "Regression Worker",
};

const OTHER: Row = {
  payTo: "Excellent Staffing",
  checkNumber: "9102",
  hours: "5",
  rate: "19",
  amount: "95",
  totalNetPay: "85",
  program: "Respite",
  individual: "Unrelated Person",
  employee: "Unrelated Worker",
};

const fetcher = (csv: string): CsvFetcher => async () => csv;

function failOnceOnSql(inner: PgLikePool, needle: string, message: string): PgLikePool {
  let failed = false;
  return {
    connect: () => inner.connect(),
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (!failed && sql.includes(needle)) {
        failed = true;
        throw new Error(message);
      }
      return inner.query<T>(sql, params);
    },
  };
}

function failOnceAfterSql(
  inner: PgLikePool,
  needle: string,
  message: string,
  onRunStarted?: () => void,
): PgLikePool {
  let failed = false;
  let runStarted = false;
  return {
    connect: () => inner.connect(),
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await inner.query<T>(sql, params);
      if (!runStarted && sql.includes("INSERT INTO sheet_sync_runs")) {
        runStarted = true;
        onRunStarted?.();
      }
      if (!failed && sql.includes(needle)) {
        failed = true;
        throw new Error(message);
      }
      return result;
    },
  };
}

function toCsv(grid: string[][]): string {
  return grid
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

function sheet(rows: Row[]): string {
  const totals = new Array(20).fill("");
  totals[16] = rows.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(2);
  const header = new Array(20).fill("");
  header[0] = "Pay to";
  header[3] = "Code";
  header[10] = "Paid CC2 Description";
  header[11] = "Paid CC3 Description";
  header[12] = "Employee Memo";
  const data = rows.map((row) => {
    const cells = new Array(20).fill("");
    cells[0] = row.payTo;
    cells[1] = "05/25/2023";
    cells[2] = row.checkNumber;
    cells[4] = row.hours;
    cells[5] = row.rate;
    cells[6] = row.amount;
    cells[7] = row.totalNetPay;
    cells[8] = "05/01/2023";
    cells[9] = "05/15/2023";
    cells[10] = row.program;
    cells[11] = row.individual;
    cells[12] = row.employee;
    cells[13] = row.paid ?? "";
    cells[15] = row.internal ?? "";
    return cells;
  });
  return toCsv([totals, header, ...data]);
}

async function sync(
  rows: Row[],
  trigger: "manual" | "scheduled" | "initial" = "scheduled",
): Promise<Awaited<ReturnType<typeof runSheetSync>>> {
  return runSheetSync(pool, {
    trigger,
    userId: null,
    fetcher: fetcher(sheet(rows)),
    config: CONFIG,
  });
}

async function initialSync(rows: Row[] = [BASE, OTHER]): Promise<void> {
  await sync(rows, "initial");
}

async function transactionId(checkNumber = BASE.checkNumber): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM payroll_transactions WHERE check_number = $1 ORDER BY id LIMIT 1`,
    [checkNumber],
  );
  return rows[0]!.id;
}

async function ordinaryChangedConflictId(txnId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id
       FROM sheet_sync_conflicts
      WHERE payroll_transaction_id = $1
        AND type = 'changed' AND status = 'open'
        AND COALESCE(previous->>'sourceEvidenceConflict', '') = ''
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [txnId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

async function openConflictCount(txnId: string, type?: "changed" | "missing"): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM sheet_sync_conflicts
      WHERE payroll_transaction_id = $1 AND status = 'open'
        AND ($2::text IS NULL OR type = $2)`,
    [txnId, type ?? null],
  );
  return Number(rows[0]!.count);
}

suite("Sheet conflict-resolution regressions (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE sheet_sync_conflicts, sheet_sync_rows, sheet_sync_runs,
               service_allocations, service_sessions, rate_exceptions,
               payroll_transactions, import_warnings, import_rows, import_batches,
               imported_files, individual_aliases, employee_aliases,
               individuals, employees, audit_logs
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(closeTestPool);

  it("keeps an acknowledged ordinary canonical source change quiet without changing Neon", async () => {
    await initialSync();
    const txnId = await transactionId();
    const changed = { ...BASE, amount: "275" };
    await sync([changed, OTHER]);

    const conflictId = await ordinaryChangedConflictId(txnId);
    expect(await dismissConflict(pool, conflictId, null, "Keep the Neon amount")).toMatchObject({ ok: true });

    const later = await sync([{ ...OTHER, paid: "Paid" }, changed]);
    expect(later.changed).toBe(0);
    expect(await openConflictCount(txnId)).toBe(0);

    const { rows } = await pool.query<{
      amount: string;
      source_amount: string;
      transaction_fingerprint: string;
      source_fingerprint: string;
    }>(
      `SELECT t.imported_amount::text AS amount,
              s.identity->>'amount' AS source_amount,
              t.transaction_fingerprint,
              s.fingerprint AS source_fingerprint
         FROM payroll_transactions t
         JOIN sheet_sync_rows s ON s.payroll_transaction_id = t.id
        WHERE t.id = $1`,
      [txnId],
    );
    expect(rows).toEqual([{
      amount: "250.0000",
      source_amount: "275",
      transaction_fingerprint: expect.not.stringMatching(/^$/),
      source_fingerprint: expect.not.stringMatching(/^$/),
    }]);
    expect(rows[0]!.source_fingerprint).not.toBe(rows[0]!.transaction_fingerprint);
  });

  it("holds canonical and accepted source fingerprints that simultaneously claim one transaction", async () => {
    await initialSync();
    const txnId = await transactionId();
    const acceptedChange = { ...BASE, amount: "275" };
    await sync([acceptedChange, OTHER]);
    const acknowledgedId = await ordinaryChangedConflictId(txnId);
    expect(await dismissConflict(pool, acknowledgedId, null, "Keep canonical Neon values")).toMatchObject({ ok: true });

    const { rows: baselines } = await pool.query<{
      canonical_fingerprint: string;
      accepted_fingerprint: string;
    }>(
      `SELECT t.transaction_fingerprint AS canonical_fingerprint,
              s.fingerprint AS accepted_fingerprint
         FROM payroll_transactions t
         JOIN sheet_sync_rows s ON s.payroll_transaction_id = t.id
        WHERE t.id = $1`,
      [txnId],
    );
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.accepted_fingerprint).not.toBe(baselines[0]!.canonical_fingerprint);

    const result = await sync([BASE, acceptedChange, { ...OTHER, paid: "Paid" }]);
    expect(result).toMatchObject({ changed: 1, flagged: 1 });
    const { rows: ambiguity } = await pool.query<{
      transaction_id: string | null;
      candidate_count: number;
      candidate_ids: string[];
      marker: string;
      source_fingerprints: string[];
      occurrence_count: string;
      source_rows: number[];
    }>(
      `SELECT payroll_transaction_id AS transaction_id,
              (previous->>'candidateCount')::int AS candidate_count,
              previous->'candidateTransactionIds' AS candidate_ids,
              incoming->>'canonicalSourceAmbiguity' AS marker,
              incoming->'sourceFingerprints' AS source_fingerprints,
              incoming->>'sourceOccurrenceCount' AS occurrence_count,
              incoming->'sourceRowNumbers' AS source_rows
         FROM sheet_sync_conflicts
        WHERE type = 'changed' AND status = 'open'
          AND incoming->>'canonicalSourceAmbiguity' = 'multiple_fingerprints_for_one_transaction'`,
    );
    expect(ambiguity).toEqual([{
      transaction_id: null,
      candidate_count: 1,
      candidate_ids: [txnId],
      marker: "multiple_fingerprints_for_one_transaction",
      source_fingerprints: [
        baselines[0]!.canonical_fingerprint,
        baselines[0]!.accepted_fingerprint,
      ].sort(),
      occurrence_count: "2",
      source_rows: [3, 4],
    }]);
    const { rows: unchanged } = await pool.query<{ amount: string; count: string }>(
      `SELECT min(imported_amount)::text AS amount, count(*)::text AS count
         FROM payroll_transactions WHERE check_number = $1`,
      [BASE.checkNumber],
    );
    expect(unchanged).toEqual([{ amount: "250.0000", count: "1" }]);
  });

  it.each([
    ["missing then evidence", ["missing", "evidence"] as const],
    ["evidence then missing", ["evidence", "missing"] as const],
  ])("keeps a whole missing acknowledgement durable when dismissed %s", async (_label, order) => {
    await initialSync();
    const txnId = await transactionId();
    const evidenceDrift = { ...BASE, payTo: "Direct Employee", totalNetPay: "230" };
    await sync([evidenceDrift, OTHER]);
    await sync([OTHER]);

    const { rows: conflicts } = await pool.query<{ id: string; facet: string }>(
      `SELECT id,
              CASE
                WHEN type = 'missing' THEN 'missing'
                WHEN previous->>'sourceEvidenceConflict' = 'routing_or_net' THEN 'evidence'
                ELSE 'other'
              END AS facet
         FROM sheet_sync_conflicts
        WHERE payroll_transaction_id = $1 AND status = 'open'`,
      [txnId],
    );
    expect(conflicts.map((row) => row.facet).sort()).toEqual(["evidence", "missing"]);

    for (const facet of order) {
      const conflict = conflicts.find((row) => row.facet === facet)!;
      expect(await dismissConflict(pool, conflict.id, null, `accepted ${facet}`)).toMatchObject({ ok: true });
    }

    const later = await sync([{ ...OTHER, paid: "Paid" }]);
    expect(later.missing).toBe(0);
    expect(await openConflictCount(txnId, "missing")).toBe(0);
    const { rows: accepted } = await pool.query<{
      missing_accepted: boolean;
      pay_to: string;
      net: string;
    }>(
      `SELECT (s.identity->>'sourceMissingAccepted')::boolean AS missing_accepted,
              t.pay_to_raw AS pay_to,
              t.total_net_pay::text AS net
         FROM sheet_sync_rows s
         JOIN payroll_transactions t ON t.id = s.payroll_transaction_id
        WHERE t.id = $1`,
      [txnId],
    );
    expect(accepted).toEqual([{
      missing_accepted: true,
      pay_to: BASE.payTo,
      net: "225.0000",
    }]);
  });

  it("adopts the lower source occurrence count when a repeat deficit is dismissed", async () => {
    await initialSync([BASE, { ...BASE }, OTHER]);
    const txnId = await transactionId();
    await sync([BASE, OTHER]);

    const { rows: conflicts } = await pool.query<{
      id: string;
      previous_count: string;
      incoming_count: string;
    }>(
      `SELECT id,
              previous->>'sourceOccurrenceCount' AS previous_count,
              incoming->>'sourceOccurrenceCount' AS incoming_count
         FROM sheet_sync_conflicts
        WHERE payroll_transaction_id = $1 AND type = 'missing' AND status = 'open'`,
      [txnId],
    );
    expect(conflicts).toEqual([{
      id: expect.any(String),
      previous_count: "2",
      incoming_count: "1",
    }]);
    expect(await dismissConflict(pool, conflicts[0]!.id, null, "One source occurrence is intentional")).toMatchObject({ ok: true });

    await sync([{ ...OTHER, paid: "Paid" }, BASE]);
    expect(await openConflictCount(txnId, "missing")).toBe(0);
    const { rows: tracking } = await pool.query<{
      occurrence_count: string;
      source_rows: number[];
      resolution: string;
    }>(
      `SELECT s.identity->>'sourceOccurrenceCount' AS occurrence_count,
              s.identity->'sourceRowNumbers' AS source_rows,
              c.resolution
         FROM sheet_sync_rows s
         JOIN sheet_sync_conflicts c ON c.payroll_transaction_id = s.payroll_transaction_id
        WHERE s.payroll_transaction_id = $1 AND c.id = $2`,
      [txnId, conflicts[0]!.id],
    );
    expect(tracking).toEqual([{
      occurrence_count: "1",
      source_rows: [4],
      resolution: "source_occurrence_count_accepted",
    }]);
  });

  it("recovers committed-but-untracked rows before evaluating an older snapshot as a no-op", async () => {
    await initialSync([BASE]);
    const interruptedPool = failOnceOnSql(
      pool,
      "INSERT INTO sheet_sync_rows",
      "injected failure after import commit and before tracking",
    );
    const interrupted = await runSheetSync(interruptedPool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(sheet([BASE, OTHER])),
      config: CONFIG,
    });
    expect(interrupted).toMatchObject({
      status: "failed",
      error: expect.stringContaining("injected failure after import commit and before tracking"),
    });

    const { rows: beforeRecovery } = await pool.query<{ transactions: string; tracking: string }>(
      `SELECT (SELECT count(*)::text FROM payroll_transactions) AS transactions,
              (SELECT count(*)::text FROM sheet_sync_rows) AS tracking`,
    );
    expect(beforeRecovery).toEqual([{ transactions: "2", tracking: "1" }]);

    const recovered = await sync([BASE]);
    expect(recovered.status).not.toBe("no_changes");
    expect(recovered.missing).toBe(1);
    const otherTxnId = await transactionId(OTHER.checkNumber);
    const { rows } = await pool.query<{
      tracking_state: string;
      review_reason: string;
      open_missing: string;
    }>(
      `SELECT s.state AS tracking_state,
              t.sync_review_reason AS review_reason,
              (SELECT count(*)::text
                 FROM sheet_sync_conflicts c
                WHERE c.payroll_transaction_id = t.id
                  AND c.type = 'missing' AND c.status = 'open') AS open_missing
         FROM payroll_transactions t
         JOIN sheet_sync_rows s ON s.payroll_transaction_id = t.id
        WHERE t.id = $1`,
      [otherTxnId],
    );
    expect(rows).toEqual([{
      tracking_state: "missing",
      review_reason: "source_missing",
      open_missing: "1",
    }]);
  });

  it("forces recovery when a queued run fails after tracking once the prior run releases the lock", async () => {
    let signalPriorFetchStarted!: () => void;
    let releasePriorFetch!: () => void;
    const priorFetchStarted = new Promise<void>((resolve) => { signalPriorFetchStarted = resolve; });
    const priorFetchRelease = new Promise<void>((resolve) => { releasePriorFetch = resolve; });
    const priorPromise = runSheetSync(pool, {
      trigger: "initial",
      userId: null,
      fetcher: async () => {
        signalPriorFetchStarted();
        await priorFetchRelease;
        return sheet([BASE]);
      },
      config: CONFIG,
    });
    await priorFetchStarted;

    let signalQueuedRunStarted!: () => void;
    const queuedRunStarted = new Promise<void>((resolve) => { signalQueuedRunStarted = resolve; });
    const queuedPool = failOnceAfterSql(
      pool,
      "SET status = 'superseded', resolution = 'newer_source_snapshot'",
      "injected failure after transaction and tracking writes",
      signalQueuedRunStarted,
    );
    const queuedPromise = runSheetSync(queuedPool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(sheet([BASE, OTHER])),
      config: CONFIG,
    });
    await queuedRunStarted;
    releasePriorFetch();

    const prior = await priorPromise;
    const queued = await queuedPromise;
    expect(prior.status).toBe("success");
    expect(queued).toMatchObject({
      status: "failed",
      error: expect.stringContaining("injected failure after transaction and tracking writes"),
    });
    const { rows: timing } = await pool.query<{
      queued_before_prior_finished: boolean;
      queued_started_after_prior: boolean;
      queued_finished_after_prior: boolean;
    }>(
      `SELECT queued.created_at < prior.finished_at AS queued_before_prior_finished,
              queued.started_at > prior.finished_at AS queued_started_after_prior,
              queued.finished_at > prior.finished_at AS queued_finished_after_prior
         FROM sheet_sync_runs queued
         JOIN sheet_sync_runs prior ON prior.id = $1
        WHERE queued.id = $2`,
      [prior.runId, queued.runId],
    );
    expect(timing).toEqual([{
      queued_before_prior_finished: true,
      queued_started_after_prior: true,
      queued_finished_after_prior: true,
    }]);
    const { rows: partiallyWritten } = await pool.query<{ transactions: string; tracking: string }>(
      `SELECT (SELECT count(*)::text FROM payroll_transactions) AS transactions,
              (SELECT count(*)::text FROM sheet_sync_rows) AS tracking`,
    );
    expect(partiallyWritten).toEqual([{ transactions: "2", tracking: "2" }]);

    const recovered = await sync([BASE]);
    expect(recovered.status).not.toBe("no_changes");
    expect(recovered.missing).toBe(1);
    const otherTxnId = await transactionId(OTHER.checkNumber);
    expect(await openConflictCount(otherTxnId, "missing")).toBe(1);
  });

  it("applies a reviewed exact-repeat group only for one fingerprint and one evidence key", async () => {
    await initialSync([BASE, { ...BASE }, OTHER]);
    const txnId = await transactionId();
    const changed = { ...BASE, amount: "275" };
    const reviewedSheet = sheet([changed, { ...changed }, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(reviewedSheet),
      config: CONFIG,
    });
    const conflictId = await ordinaryChangedConflictId(txnId);

    const countMismatch = await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(sheet([changed, OTHER])),
      config: CONFIG,
    });
    expect(countMismatch).toMatchObject({ ok: false, code: "conflict" });

    const fingerprintMismatch = await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(sheet([changed, { ...changed, amount: "280" }, OTHER])),
      config: CONFIG,
    });
    expect(fingerprintMismatch).toMatchObject({ ok: false, code: "conflict" });

    const evidenceMismatch = await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(sheet([changed, { ...changed, payTo: "Direct Employee" }, OTHER])),
      config: CONFIG,
    });
    expect(evidenceMismatch).toMatchObject({ ok: false, code: "conflict" });

    expect(await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(reviewedSheet),
      config: CONFIG,
    })).toMatchObject({ ok: true });

    const { rows } = await pool.query<{ amount: string; transactions: string }>(
      `SELECT min(imported_amount)::text AS amount, count(*)::text AS transactions
         FROM payroll_transactions WHERE check_number = $1`,
      [BASE.checkNumber],
    );
    expect(rows).toEqual([{ amount: "275.0000", transactions: "1" }]);
  });

  it("uses the reviewed two-occurrence target when the prior baseline contained one occurrence", async () => {
    await initialSync();
    const txnId = await transactionId();
    const changed = { ...BASE, amount: "275" };
    const changedRepeatSheet = sheet([changed, { ...changed }, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(changedRepeatSheet),
      config: CONFIG,
    });
    const conflictId = await ordinaryChangedConflictId(txnId);
    const { rows: reviewed } = await pool.query<{ occurrence_count: string; fingerprints: number }>(
      `SELECT incoming->>'sourceOccurrenceCount' AS occurrence_count,
              jsonb_array_length(incoming->'sourceRowNumbers') AS fingerprints
         FROM sheet_sync_conflicts WHERE id = $1`,
      [conflictId],
    );
    expect(reviewed).toEqual([{ occurrence_count: "2", fingerprints: 2 }]);

    expect(await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(changedRepeatSheet),
      config: CONFIG,
    })).toMatchObject({ ok: true });
    const { rows } = await pool.query<{ amount: string; occurrence_count: string }>(
      `SELECT t.imported_amount::text AS amount,
              s.identity->>'sourceOccurrenceCount' AS occurrence_count
         FROM payroll_transactions t
         JOIN sheet_sync_rows s ON s.payroll_transaction_id = t.id
        WHERE t.id = $1`,
      [txnId],
    );
    expect(rows).toEqual([{ amount: "275.0000", occurrence_count: "2" }]);
  });

  it("does not shrink accepted multi-key evidence while applying an ordinary canonical conflict", async () => {
    await initialSync();
    const txnId = await transactionId();
    const changed = { ...BASE, amount: "275" };
    const evidenceVariant = { ...changed, payTo: "Direct Employee", totalNetPay: "230" };
    const reviewedSheet = sheet([changed, evidenceVariant, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(reviewedSheet),
      config: CONFIG,
    });
    const { rows: evidenceConflicts } = await pool.query<{ id: string }>(
      `SELECT id FROM sheet_sync_conflicts
        WHERE payroll_transaction_id = $1 AND status = 'open'
          AND previous->>'sourceEvidenceConflict' = 'routing_or_net'`,
      [txnId],
    );
    expect(evidenceConflicts).toHaveLength(1);
    expect(await dismissConflict(pool, evidenceConflicts[0]!.id, null, "Accept both evidence variants")).toMatchObject({ ok: true });
    const canonicalConflictId = await ordinaryChangedConflictId(txnId);
    const { rows: beforeApply } = await pool.query<{ keys: string[]; amount: string }>(
      `SELECT s.identity->'sourceEvidenceKeys' AS keys,
              t.imported_amount::text AS amount
         FROM sheet_sync_rows s
         JOIN payroll_transactions t ON t.id = s.payroll_transaction_id
        WHERE t.id = $1`,
      [txnId],
    );
    expect(beforeApply).toHaveLength(1);
    expect(beforeApply[0]!.keys).toHaveLength(2);
    expect(beforeApply[0]!.amount).toBe("250.0000");

    const singletonEvidenceSheet = sheet([changed, { ...changed }, OTHER]);
    expect(await applyChangedConflict(pool, canonicalConflictId, null, {
      fetcher: fetcher(singletonEvidenceSheet),
      config: CONFIG,
    })).toMatchObject({ ok: false });

    const { rows: afterApply } = await pool.query<{ keys: string[]; amount: string; conflict_status: string }>(
      `SELECT s.identity->'sourceEvidenceKeys' AS keys,
              t.imported_amount::text AS amount,
              c.status AS conflict_status
         FROM sheet_sync_rows s
         JOIN payroll_transactions t ON t.id = s.payroll_transaction_id
         JOIN sheet_sync_conflicts c ON c.id = $2
        WHERE t.id = $1`,
      [txnId, canonicalConflictId],
    );
    expect(afterApply).toEqual([{
      keys: beforeApply[0]!.keys,
      amount: "250.0000",
      conflict_status: "open",
    }]);
  });

  it("recomputes applied money and attribution from the preserved Neon Pay-To", async () => {
    await initialSync();
    const txnId = await transactionId();
    const combined = {
      ...BASE,
      payTo: BASE.employee,
      amount: "300",
      internal: "999",
    };
    const combinedSheet = sheet([combined, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(combinedSheet),
      config: CONFIG,
    });
    const { rows: evidenceConflicts } = await pool.query<{ id: string }>(
      `SELECT id FROM sheet_sync_conflicts
        WHERE payroll_transaction_id = $1 AND status = 'open'
          AND previous->>'sourceEvidenceConflict' = 'routing_or_net'`,
      [txnId],
    );
    expect(evidenceConflicts).toHaveLength(1);
    expect(await dismissConflict(pool, evidenceConflicts[0]!.id, null, "Accept source routing evidence only"))
      .toMatchObject({ ok: true });
    const canonicalConflictId = await ordinaryChangedConflictId(txnId);

    expect(await applyChangedConflict(pool, canonicalConflictId, null, {
      fetcher: fetcher(combinedSheet),
      config: CONFIG,
    })).toMatchObject({ ok: true });

    const { rows } = await pool.query<{
      pay_to: string;
      imported_amount: string;
      spreadsheet_internal: string;
      calculated_internal: string;
      mismatch: boolean;
      recipient: string;
      employee_payment: string;
      agency_additional: string;
    }>(
      `SELECT pay_to_raw AS pay_to,
              imported_amount::text AS imported_amount,
              spreadsheet_internal_amount::text AS spreadsheet_internal,
              calculated_internal_amount::text AS calculated_internal,
              internal_amount_mismatch AS mismatch,
              payment_recipient AS recipient,
              employee_payment_amount::text AS employee_payment,
              agency_additional_amount::text AS agency_additional
         FROM payroll_transactions WHERE id = $1`,
      [txnId],
    );
    expect(rows).toEqual([{
      pay_to: BASE.payTo,
      imported_amount: "300.0000",
      spreadsheet_internal: "999.0000",
      calculated_internal: "252.0000",
      mismatch: true,
      recipient: "excellent_staffing",
      employee_payment: "252.0000",
      agency_additional: "48.0000",
    }]);
  });

  it("refuses to apply a changed conflict when the transaction belongs to a multi-person service session", async () => {
    await initialSync();
    const txnId = await transactionId();
    const changed = { ...BASE, amount: "275" };
    const changedSheet = sheet([changed, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(changedSheet),
      config: CONFIG,
    });
    const conflictId = await ordinaryChangedConflictId(txnId);
    const { rows: sessions } = await pool.query<{ id: string }>(
      `INSERT INTO service_sessions
         (import_batch_id, employee_id, program_id, check_number,
          period_begin, period_end, physical_hours, group_size,
          combined_rate, combined_amount, base_individual_rate, group_detection_status)
        SELECT import_batch_id, employee_id, program_id, check_number,
               period_begin, period_end, imported_hours, 2,
               imported_rate, imported_amount, internal_rate_applied, 'confirmed'
         FROM payroll_transactions WHERE id = $1
       RETURNING id`,
      [txnId],
    );
    const sessionId = sessions[0]!.id;
    const { rows: allocations } = await pool.query<{ id: string }>(
      `INSERT INTO service_allocations
         (service_session_id, individual_id, payroll_transaction_id,
          allocation_hours, allocated_rate, allocated_amount)
       SELECT $2, individual_id, id, imported_hours, imported_rate, imported_amount
         FROM payroll_transactions WHERE id = $1
       RETURNING id`,
      [txnId, sessionId],
    );
    const allocationId = allocations[0]!.id;
    await pool.query(
      `UPDATE payroll_transactions
          SET service_session_id = $2, is_group_service = true
        WHERE id = $1`,
      [txnId, sessionId],
    );

    type LinkedSnapshot = {
      imported_hours: string;
      imported_rate: string;
      imported_amount: string;
      calculated_internal: string;
      service_session_id: string;
      physical_hours: string;
      combined_rate: string;
      combined_amount: string;
      allocation_hours: string;
      allocated_rate: string;
      allocated_amount: string;
    };
    const readLinkedSnapshot = async (): Promise<LinkedSnapshot[]> => {
      const { rows } = await pool.query<LinkedSnapshot>(
        `SELECT t.imported_hours::text,
                t.imported_rate::text,
                t.imported_amount::text,
                t.calculated_internal_amount::text AS calculated_internal,
                t.service_session_id::text,
                s.physical_hours::text,
                s.combined_rate::text,
                s.combined_amount::text,
                a.allocation_hours::text,
                a.allocated_rate::text,
                a.allocated_amount::text
           FROM payroll_transactions t
           JOIN service_sessions s ON s.id = t.service_session_id
           JOIN service_allocations a ON a.payroll_transaction_id = t.id
          WHERE t.id = $1 AND s.id = $2 AND a.id = $3`,
        [txnId, sessionId, allocationId],
      );
      return rows;
    };
    const before = await readLinkedSnapshot();
    expect(before).toHaveLength(1);

    expect(await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(changedSheet),
      config: CONFIG,
    })).toMatchObject({ ok: false });

    expect(await readLinkedSnapshot()).toEqual(before);
    const { rows: state } = await pool.query<{ conflict_status: string; transaction_count: string }>(
      `SELECT c.status AS conflict_status,
              (SELECT count(*)::text FROM payroll_transactions WHERE check_number = $2) AS transaction_count
         FROM sheet_sync_conflicts c WHERE c.id = $1`,
      [conflictId, BASE.checkNumber],
    );
    expect(state).toEqual([{ conflict_status: "open", transaction_count: "1" }]);
  });

  it("allows an ordinary singleton-session apply and synchronizes its session and allocation", async () => {
    await initialSync();
    const txnId = await transactionId();
    const changed = { ...BASE, hours: "12", amount: "300" };
    const changedSheet = sheet([changed, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(changedSheet),
      config: CONFIG,
    });
    const conflictId = await ordinaryChangedConflictId(txnId);

    const { rows: before } = await pool.query<{
      service_session_id: string | null;
      is_group_service: boolean;
      group_size: number;
    }>(
      `SELECT t.service_session_id::text, t.is_group_service, s.group_size
         FROM payroll_transactions t
         JOIN service_sessions s ON s.id = t.service_session_id
        WHERE t.id = $1`,
      [txnId],
    );
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ is_group_service: false, group_size: 1 });
    expect(before[0]!.service_session_id).not.toBeNull();

    expect(await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(changedSheet),
      config: CONFIG,
    })).toMatchObject({ ok: true });

    const { rows: after } = await pool.query<{
      imported_hours: string;
      imported_rate: string;
      imported_amount: string;
      is_group_service: boolean;
      group_size: number;
      physical_hours: string;
      combined_rate: string;
      combined_amount: string;
      allocation_hours: string;
      allocated_rate: string;
      allocated_amount: string;
      conflict_status: string;
    }>(
      `SELECT t.imported_hours::text,
              t.imported_rate::text,
              t.imported_amount::text,
              t.is_group_service,
              s.group_size,
              s.physical_hours::text,
              s.combined_rate::text,
              s.combined_amount::text,
              a.allocation_hours::text,
              a.allocated_rate::text,
              a.allocated_amount::text,
              c.status AS conflict_status
         FROM payroll_transactions t
         JOIN service_sessions s ON s.id = t.service_session_id
         JOIN service_allocations a ON a.payroll_transaction_id = t.id
         JOIN sheet_sync_conflicts c ON c.id = $2
        WHERE t.id = $1`,
      [txnId, conflictId],
    );
    expect(after).toEqual([{
      imported_hours: "12.0000",
      imported_rate: "25.0000",
      imported_amount: "300.0000",
      is_group_service: false,
      group_size: 1,
      physical_hours: "12.0000",
      combined_rate: "25.0000",
      combined_amount: "300.0000",
      allocation_hours: "12.0000",
      allocated_rate: "25.0000",
      allocated_amount: "300.0000",
      conflict_status: "applied",
    }]);

    const { rows: auditRows } = await pool.query<{
      metadata: {
        previous: {
          transaction: Record<string, unknown>;
          serviceSession: Record<string, unknown>;
          serviceAllocations: Record<string, unknown>[];
          conflict: Record<string, unknown>;
        };
        next: {
          transaction: Record<string, unknown>;
          serviceSession: Record<string, unknown>;
          serviceAllocations: Record<string, unknown>[];
          conflict: Record<string, unknown>;
        };
      };
    }>(
      `SELECT metadata
         FROM audit_logs
        WHERE action = 'sheet_sync_change_applied'
          AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [txnId],
    );
    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0]!.metadata;
    expect(Number(audit.previous.transaction.imported_hours)).toBe(10);
    expect(Number(audit.next.transaction.imported_hours)).toBe(12);
    expect(Number(audit.previous.serviceSession.physical_hours)).toBe(10);
    expect(Number(audit.next.serviceSession.physical_hours)).toBe(12);
    expect(Number(audit.previous.serviceAllocations[0]!.allocation_hours)).toBe(10);
    expect(Number(audit.next.serviceAllocations[0]!.allocation_hours)).toBe(12);
    expect(audit.previous.conflict.status).toBe("open");
    expect(audit.next.conflict.status).toBe("applied");
  });

  it("centrally audits a changed conflict that closes after its source identity disappears", async () => {
    await initialSync();
    const txnId = await transactionId();
    const changed = { ...BASE, amount: "275" };
    await sync([changed, OTHER]);
    const conflictId = await ordinaryChangedConflictId(txnId);

    expect(await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(sheet([OTHER])),
      config: CONFIG,
    })).toMatchObject({ ok: false, code: "conflict" });

    const { rows } = await pool.query<{
      status: string;
      resolution: string | null;
      action: string;
      previous_status: string;
      next_status: string;
      previous_review_reason: string | null;
      next_review_reason: string | null;
    }>(
      `SELECT c.status, c.resolution, a.action,
              a.metadata->'previous'->'conflict'->>'status' AS previous_status,
              a.metadata->'next'->'conflict'->>'status' AS next_status,
              a.metadata->'previous'->'transaction'->>'sync_review_reason' AS previous_review_reason,
              a.metadata->'next'->'transaction'->>'sync_review_reason' AS next_review_reason
         FROM sheet_sync_conflicts c
         JOIN audit_logs a ON a.entity_id = c.id
        WHERE c.id = $1 AND a.action = 'sheet_sync_change_source_reverted'`,
      [conflictId],
    );
    expect(rows).toEqual([{
      status: "dismissed",
      resolution: "source_reverted",
      action: "sheet_sync_change_source_reverted",
      previous_status: "open",
      next_status: "dismissed",
      previous_review_reason: "source_changed",
      next_review_reason: null,
    }]);
  });

  it("refuses a row-level apply when the current Sheet row newly forms a multi-person group", async () => {
    await initialSync();
    const txnId = await transactionId();
    const changed = { ...BASE, rate: "50", amount: "500" };
    const reviewedSheet = sheet([changed, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(reviewedSheet),
      config: CONFIG,
    });
    const conflictId = await ordinaryChangedConflictId(txnId);

    type Snapshot = {
      imported_hours: string;
      imported_rate: string;
      imported_amount: string;
      transaction_fingerprint: string;
      is_group_service: boolean;
      service_session_id: string | null;
      transaction_count: string;
      session_count: string;
      allocation_count: string;
      conflict_status: string;
    };
    const readSnapshot = async (): Promise<Snapshot[]> => {
      const { rows } = await pool.query<Snapshot>(
        `SELECT t.imported_hours::text,
                t.imported_rate::text,
                t.imported_amount::text,
                t.transaction_fingerprint,
                t.is_group_service,
                t.service_session_id::text,
                (SELECT count(*)::text FROM payroll_transactions) AS transaction_count,
                (SELECT count(*)::text FROM service_sessions) AS session_count,
                (SELECT count(*)::text FROM service_allocations) AS allocation_count,
                c.status AS conflict_status
           FROM payroll_transactions t
           JOIN sheet_sync_conflicts c ON c.id = $2
          WHERE t.id = $1`,
        [txnId, conflictId],
      );
      return rows;
    };
    const before = await readSnapshot();
    expect(before).toHaveLength(1);
    expect(before[0]!.is_group_service).toBe(false);

    const newlyGroupedSheet = sheet([
      changed,
      { ...changed, individual: "Regression Group Peer" },
      OTHER,
    ]);
    expect(await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(newlyGroupedSheet),
      config: CONFIG,
    })).toMatchObject({ ok: false });

    expect(await readSnapshot()).toEqual(before);
  });

  it("holds every member when a newly formed source group contains a changed canonical transaction", async () => {
    await initialSync();
    const txnId = await transactionId();
    const groupLead = { ...BASE, rate: "50", amount: "500" };
    const groupPeer = { ...groupLead, individual: "Regression Group Peer" };

    type Counts = {
      transactions: string;
      sessions: string;
      allocations: string;
    };
    const readCounts = async (): Promise<Counts[]> => {
      const { rows } = await pool.query<Counts>(
        `SELECT (SELECT count(*)::text FROM payroll_transactions) AS transactions,
                (SELECT count(*)::text FROM service_sessions) AS sessions,
                (SELECT count(*)::text FROM service_allocations) AS allocations`,
      );
      return rows;
    };
    const before = await readCounts();

    const result = await sync([groupLead, groupPeer, OTHER]);
    expect(result.added).toBe(0);
    expect(result.flagged).toBeGreaterThan(0);
    expect(await readCounts()).toEqual(before);

    const { rows: canonical } = await pool.query<{
      amount: string;
      is_group_service: boolean;
      peer_transactions: string;
    }>(
      `SELECT t.imported_amount::text AS amount,
              t.is_group_service,
              (SELECT count(*)::text
                 FROM payroll_transactions peer
                WHERE peer.individual_raw = $2) AS peer_transactions
         FROM payroll_transactions t
        WHERE t.id = $1`,
      [txnId, groupPeer.individual],
    );
    expect(canonical).toEqual([{
      amount: "250.0000",
      is_group_service: false,
      peer_transactions: "0",
    }]);
  });

  it("does not commit a detectable group sibling when the other member has an invalid amount", async () => {
    const groupLead = { ...BASE, rate: "50", amount: "500" };
    const invalidPeer = {
      ...groupLead,
      individual: "Regression Invalid Group Peer",
      amount: "not-a-number",
    };

    const result = await sync([groupLead, invalidPeer, OTHER], "initial");
    expect(result.added).toBe(1);
    expect(result.flagged).toBeGreaterThan(0);
    expect(result.failed).toBe(1);
    expect(result.reconciliation?.importedAgencyGross).toBe("95.0000");
    expect(result.reconciliation?.pendingAtomicGroupHolds).toHaveLength(1);

    const { rows } = await pool.query<{
      group_transactions: string;
      group_sessions: string;
      group_allocations: string;
    }>(
      `SELECT (SELECT count(*)::text
                 FROM payroll_transactions
                WHERE check_number = $1) AS group_transactions,
              (SELECT count(*)::text
                 FROM service_sessions
                WHERE check_number = $1) AS group_sessions,
              (SELECT count(*)::text
                 FROM service_allocations allocation
                 JOIN service_sessions session ON session.id = allocation.service_session_id
                WHERE session.check_number = $1) AS group_allocations`,
      [groupLead.checkNumber],
    );
    expect(rows).toEqual([{
      group_transactions: "0",
      group_sessions: "0",
      group_allocations: "0",
    }]);
  });

  it("re-evaluates an identical snapshot while an existing-plus-new group remains held", async () => {
    const groupLead = { ...BASE, rate: "50", amount: "500" };
    const groupPeer = { ...groupLead, individual: "Regression Pending Group Peer" };
    await initialSync([groupLead, OTHER]);

    const firstHeld = await sync([groupLead, groupPeer, OTHER]);
    expect(firstHeld.status).toBe("success");
    expect(firstHeld.added).toBe(0);
    expect(firstHeld.flagged).toBeGreaterThan(0);
    expect(firstHeld.reconciliation?.importedAgencyGross).toBe("0.0000");
    expect(firstHeld.reconciliation?.pendingAtomicGroupHolds).toHaveLength(1);

    const identicalRetry = await sync([groupLead, groupPeer, OTHER]);
    expect(identicalRetry.status).toBe("success");
    expect(identicalRetry.status).not.toBe("no_changes");
    expect(identicalRetry.added).toBe(0);
    expect(identicalRetry.flagged).toBeGreaterThan(0);
    expect(identicalRetry.reconciliation?.pendingAtomicGroupHolds).toHaveLength(1);

    const { rows } = await pool.query<{ peer_transactions: string; sessions: string }>(
      `SELECT (SELECT count(*)::text
                 FROM payroll_transactions
                WHERE individual_raw = $1) AS peer_transactions,
              (SELECT count(*)::text
                 FROM service_sessions
                WHERE check_number = $2) AS sessions`,
      [groupPeer.individual, groupLead.checkNumber],
    );
    expect(rows).toEqual([{ peer_transactions: "0", sessions: "1" }]);
  });

  it("updates both applied rate snapshots from current staging when applying a canonical change", async () => {
    await initialSync();
    const txnId = await transactionId();
    const changed = { ...BASE, amount: "275" };
    const changedSheet = sheet([changed, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(changedSheet),
      config: CONFIG,
    });
    const conflictId = await ordinaryChangedConflictId(txnId);
    await pool.query(
      `UPDATE payroll_transactions
          SET internal_rate_applied = 1, agency_rate_applied = 2
        WHERE id = $1`,
      [txnId],
    );

    expect(await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(changedSheet),
      config: CONFIG,
    })).toMatchObject({ ok: true });

    const { rows } = await pool.query<{
      internal_rate: string;
      agency_rate: string;
      expected_internal_rate: string;
      expected_agency_rate: string;
    }>(
      `SELECT t.internal_rate_applied::text AS internal_rate,
              t.agency_rate_applied::text AS agency_rate,
              rates.internal_rate::text AS expected_internal_rate,
              rates.agency_rate::text AS expected_agency_rate
         FROM payroll_transactions t
         JOIN LATERAL (
           SELECT prs.internal_rate, prs.agency_rate
             FROM program_rate_schedules prs
            WHERE prs.program_id = t.program_id
              AND prs.effective_from <= t.period_begin
              AND (prs.effective_to IS NULL OR prs.effective_to >= t.period_begin)
            ORDER BY prs.effective_from DESC, prs.id DESC
            LIMIT 1
         ) rates ON true
        WHERE t.id = $1`,
      [txnId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.internal_rate).toBe(rows[0]!.expected_internal_rate);
    expect(rows[0]!.agency_rate).toBe(rows[0]!.expected_agency_rate);
    expect(rows[0]!.internal_rate).not.toBe("1.0000");
    expect(rows[0]!.agency_rate).not.toBe("2.0000");
  });

  it("retires the open rate exception when a canonical apply moves an off-ladder rate onto the ladder", async () => {
    const offLadder = { ...BASE, rate: "23", amount: "230" };
    await initialSync([offLadder, OTHER]);
    const txnId = await transactionId();
    const { rows: before } = await pool.query<{ id: string; resolution: string }>(
      `SELECT id, resolution
         FROM rate_exceptions
        WHERE payroll_transaction_id = $1
        ORDER BY created_at, id`,
      [txnId],
    );
    expect(before).toHaveLength(1);
    expect(before[0]!.resolution).toBe("open");

    const onLadderSheet = sheet([BASE, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(onLadderSheet),
      config: CONFIG,
    });
    const conflictId = await ordinaryChangedConflictId(txnId);
    expect(await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(onLadderSheet),
      config: CONFIG,
    })).toMatchObject({ ok: true });

    const { rows: after } = await pool.query<{ id: string; resolution: string }>(
      `SELECT id, resolution
         FROM rate_exceptions
        WHERE payroll_transaction_id = $1
        ORDER BY created_at, id`,
      [txnId],
    );
    expect(after.filter((row) => row.resolution === "open")).toHaveLength(0);
    expect(after.find((row) => row.id === before[0]!.id)?.resolution).not.toBe("open");
  });

  it("creates one exact open rate exception when a canonical apply moves an on-ladder rate off the ladder", async () => {
    await initialSync();
    const txnId = await transactionId();
    const offLadder = { ...BASE, rate: "23", amount: "230" };
    const offLadderSheet = sheet([offLadder, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(offLadderSheet),
      config: CONFIG,
    });
    const conflictId = await ordinaryChangedConflictId(txnId);
    expect(await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(offLadderSheet),
      config: CONFIG,
    })).toMatchObject({ ok: true });

    const { rows } = await pool.query<{
      payroll_transaction_id: string;
      imported_rate: string;
      expected_rate: string;
      variance_amount: string;
      direction: string;
      resolution: string;
    }>(
      `SELECT payroll_transaction_id::text,
              imported_rate::text,
              expected_rate::text,
              variance_amount::text,
              direction,
              resolution
         FROM rate_exceptions
        WHERE payroll_transaction_id = $1 AND resolution = 'open'
        ORDER BY created_at, id`,
      [txnId],
    );
    expect(rows).toEqual([{
      payroll_transaction_id: txnId,
      imported_rate: "23.0000",
      expected_rate: "21.0000",
      variance_amount: "2.0000",
      direction: "higher",
      resolution: "open",
    }]);
  });

  it("keeps one exact open rate exception when repeated changed source rows move off the ladder", async () => {
    await initialSync();
    const txnId = await transactionId();
    const offLadder = { ...BASE, rate: "23", amount: "230" };
    const repeatedOffLadderSheet = sheet([offLadder, { ...offLadder }, OTHER]);
    await runSheetSync(pool, {
      trigger: "scheduled",
      userId: null,
      fetcher: fetcher(repeatedOffLadderSheet),
      config: CONFIG,
    });
    const conflictId = await ordinaryChangedConflictId(txnId);

    expect(await applyChangedConflict(pool, conflictId, null, {
      fetcher: fetcher(repeatedOffLadderSheet),
      config: CONFIG,
    })).toMatchObject({ ok: true });

    const { rows } = await pool.query<{
      imported_rate: string;
      expected_rate: string;
      variance_amount: string;
      direction: string;
      resolution: string;
      conflict_status: string;
    }>(
      `SELECT exception.imported_rate::text,
              exception.expected_rate::text,
              exception.variance_amount::text,
              exception.direction,
              exception.resolution,
              conflict.status AS conflict_status
         FROM rate_exceptions exception
         JOIN sheet_sync_conflicts conflict ON conflict.id = $2
        WHERE exception.payroll_transaction_id = $1
          AND exception.resolution = 'open'
        ORDER BY exception.created_at, exception.id`,
      [txnId, conflictId],
    );
    expect(rows).toEqual([{
      imported_rate: "23.0000",
      expected_rate: "21.0000",
      variance_amount: "2.0000",
      direction: "higher",
      resolution: "open",
      conflict_status: "applied",
    }]);
  });

  it.each([
    ["original evidence first", [BASE, { ...BASE, payTo: "Direct Employee", totalNetPay: "230" }]],
    ["variant evidence first", [{ ...BASE, payTo: "Direct Employee", totalNetPay: "230" }, BASE]],
  ] as const)("holds a new canonical fingerprint with routing/net variants before import: %s", async (_label, sourceRows) => {
    const result = await sync([...sourceRows], "initial");
    expect(result).toMatchObject({ added: 0, changed: 1, flagged: 1 });
    const { rows: authoritative } = await pool.query<{
      transactions: string;
      service_sessions: string;
      allocations: string;
      imported_rows: number;
    }>(
      `SELECT (SELECT count(*)::text FROM payroll_transactions) AS transactions,
              (SELECT count(*)::text FROM service_sessions) AS service_sessions,
              (SELECT count(*)::text FROM service_allocations) AS allocations,
              (SELECT imported_rows FROM import_batches WHERE id = $1) AS imported_rows`,
      [result.importBatchId],
    );
    expect(authoritative).toEqual([{
      transactions: "0",
      service_sessions: "0",
      allocations: "0",
      imported_rows: 0,
    }]);

    const { rows: conflicts } = await pool.query<{
      transaction_id: string | null;
      candidate_count: number;
      marker: string;
      reason: string;
      evidence_count: number;
      occurrence_count: string;
      source_rows: number[];
    }>(
      `SELECT payroll_transaction_id AS transaction_id,
              (previous->>'candidateCount')::int AS candidate_count,
              previous->>'sourceEvidenceConflict' AS marker,
              previous->>'sourceEvidenceConflictReason' AS reason,
              jsonb_array_length(incoming->'sourceEvidenceKeys') AS evidence_count,
              incoming->>'sourceOccurrenceCount' AS occurrence_count,
              incoming->'sourceRowNumbers' AS source_rows
         FROM sheet_sync_conflicts
        WHERE type = 'changed' AND status = 'open'`,
    );
    expect(conflicts).toEqual([{
      transaction_id: null,
      candidate_count: 0,
      marker: "routing_or_net",
      reason: "variants",
      evidence_count: 2,
      occurrence_count: "2",
      source_rows: [3, 4],
    }]);
  });

  it("tracks and restores new evidence variants independently for two fingerprints sharing one natural key", async () => {
    const first = BASE;
    const firstVariant = { ...first, payTo: "Direct Employee", totalNetPay: "230" };
    const second = { ...BASE, hours: "5", amount: "125", totalNetPay: "110" };
    const secondVariant = { ...second, payTo: "Direct Employee", totalNetPay: "115" };

    const initial = await sync([first, firstVariant, second, secondVariant], "initial");
    expect(initial).toMatchObject({ added: 0, changed: 2, flagged: 2 });

    const { rows: initialConflicts } = await pool.query<{
      id: string;
      fingerprint: string;
      source_rows: number[];
      evidence_count: number;
    }>(
      `SELECT id,
              incoming->>'sourceFingerprint' AS fingerprint,
              incoming->'sourceRowNumbers' AS source_rows,
              jsonb_array_length(incoming->'sourceEvidenceKeys') AS evidence_count
         FROM sheet_sync_conflicts
        WHERE type = 'changed' AND status = 'open'
          AND payroll_transaction_id IS NULL
          AND previous->>'sourceEvidenceConflict' = 'routing_or_net'
        ORDER BY (incoming->'sourceRowNumbers'->>0)::int`,
    );
    expect(initialConflicts).toHaveLength(2);
    expect(initialConflicts.map((conflict) => conflict.source_rows)).toEqual([[3, 4], [5, 6]]);
    expect(initialConflicts.map((conflict) => conflict.evidence_count)).toEqual([2, 2]);
    expect(new Set(initialConflicts.map((conflict) => conflict.fingerprint)).size).toBe(2);

    const firstConflict = initialConflicts[0]!;
    const secondConflict = initialConflicts[1]!;
    const restored = await sync([first, { ...first }, second, secondVariant]);
    expect(restored.added).toBe(1);

    const { rows: lifecycle } = await pool.query<{
      id: string;
      status: string;
      resolution: string | null;
      fingerprint: string;
    }>(
      `SELECT id, status, resolution, incoming->>'sourceFingerprint' AS fingerprint
         FROM sheet_sync_conflicts
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[firstConflict.id, secondConflict.id]],
    );
    const byId = new Map(lifecycle.map((row) => [row.id, row]));
    expect(byId.get(firstConflict.id)).toMatchObject({
      status: "dismissed",
      resolution: "source_evidence_restored",
      fingerprint: firstConflict.fingerprint,
    });
    expect(byId.get(secondConflict.id)).toMatchObject({
      status: "open",
      resolution: null,
      fingerprint: secondConflict.fingerprint,
    });

    const { rows: canonical } = await pool.query<{ amount: string }>(
      `SELECT imported_amount::text AS amount
         FROM payroll_transactions
        ORDER BY imported_amount`,
    );
    expect(canonical).toEqual([{ amount: "250.0000" }]);

    const heldAgain = await sync([
      { ...first, paid: "Paid" },
      { ...first, paid: "Paid" },
      second,
      secondVariant,
    ]);
    expect(heldAgain).toMatchObject({ added: 0, changed: 1, flagged: 1 });
    const { rows: stillHeld } = await pool.query<{
      id: string;
      transaction_id: string | null;
      fingerprint: string;
    }>(
      `SELECT id, payroll_transaction_id AS transaction_id,
              incoming->>'sourceFingerprint' AS fingerprint
         FROM sheet_sync_conflicts
        WHERE type = 'changed' AND status = 'open'`,
    );
    expect(stillHeld).toEqual([{
      id: secondConflict.id,
      transaction_id: null,
      fingerprint: secondConflict.fingerprint,
    }]);

    const secondRestored = await sync([
      first,
      { ...first },
      second,
      { ...second },
    ]);
    expect(secondRestored).toMatchObject({ added: 1, changed: 0, flagged: 0 });

    const { rows: finalLifecycle } = await pool.query<{
      id: string;
      status: string;
      resolution: string | null;
    }>(
      `SELECT id, status, resolution
         FROM sheet_sync_conflicts
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[firstConflict.id, secondConflict.id]],
    );
    expect(finalLifecycle).toHaveLength(2);
    expect(finalLifecycle.every((row) => row.status === "dismissed")).toBe(true);
    expect(finalLifecycle.every((row) => row.resolution === "source_evidence_restored")).toBe(true);

    const { rows: finalCanonical } = await pool.query<{ amount: string }>(
      `SELECT imported_amount::text AS amount
         FROM payroll_transactions
        ORDER BY imported_amount`,
    );
    expect(finalCanonical).toEqual([{ amount: "125.0000" }, { amount: "250.0000" }]);

    const { rows: finalOpenConflicts } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM sheet_sync_conflicts
        WHERE status = 'open'`,
    );
    expect(finalOpenConflicts).toEqual([{ count: "0" }]);
  });

  it("links each changed card to its own incoming held row instead of the shared tracking row", async () => {
    await initialSync();
    const txnId = await transactionId();
    const firstChange = { ...BASE, amount: "275" };
    const secondChange = { ...BASE, amount: "280" };
    const result = await sync([firstChange, secondChange, OTHER]);
    expect(result.changed).toBe(2);

    const cards = (await listOpenConflicts(pool, { type: "changed" }))
      .filter((card) => card.transactionId === txnId);
    expect(cards).toHaveLength(2);
    const { rows: heldRows } = await pool.query<{ id: string; source_row_number: number }>(
      `SELECT id, source_row_number
         FROM import_rows
        WHERE import_batch_id = $1 AND source_row_number IN (3, 4)`,
      [result.importBatchId],
    );
    const heldBySourceRow = new Map(heldRows.map((row) => [row.source_row_number, row.id]));
    expect(heldBySourceRow.size).toBe(2);
    for (const card of cards) {
      const sourceRowNumber = Number(card.incoming?.sourceRowNumber);
      expect([3, 4]).toContain(sourceRowNumber);
      expect(card.importRowId).toBe(heldBySourceRow.get(sourceRowNumber));
    }
    expect(new Set(cards.map((card) => card.importRowId)).size).toBe(2);
  });

  it.each([
    ["first clone inserted first", [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
    ]],
    ["second clone inserted first", [
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000001",
    ]],
  ] as const)("holds duplicate canonical ledger fingerprints as non-applicable ambiguity: %s", async (_label, cloneIds) => {
    await initialSync();
    const originalId = await transactionId();
    await pool.query(`DELETE FROM sheet_sync_rows WHERE payroll_transaction_id = $1`, [originalId]);

    for (const cloneId of cloneIds) {
      await pool.query(
        `INSERT INTO payroll_transactions
           (id, import_batch_id, import_row_id, source_file_id, source_row_number,
            pay_to_raw, check_number, check_date, period_begin, period_end,
            individual_id, employee_id, program_id, payroll_check_id,
            individual_raw, employee_raw, program_raw,
            imported_hours, imported_rate, imported_amount, total_net_pay,
            spreadsheet_internal_amount, calculated_internal_amount,
            internal_rate_applied, agency_rate_applied,
            agency_additional_amount, employee_payment_amount, payment_recipient,
            internal_amount_mismatch, transaction_fingerprint, duplicate_status,
            is_group_service, service_session_id, is_paid, paid_at, paid_note)
         SELECT $2::uuid, NULL, NULL, NULL, NULL,
                pay_to_raw, check_number, check_date, period_begin, period_end,
                individual_id, employee_id, program_id, payroll_check_id,
                individual_raw, employee_raw, program_raw,
                imported_hours, imported_rate, imported_amount, total_net_pay,
                spreadsheet_internal_amount, calculated_internal_amount,
                internal_rate_applied, agency_rate_applied,
                agency_additional_amount, employee_payment_amount, payment_recipient,
                internal_amount_mismatch, transaction_fingerprint, duplicate_status,
                is_group_service, service_session_id, is_paid, paid_at, paid_note
           FROM payroll_transactions WHERE id = $1`,
        [originalId, cloneId],
      );
    }
    await pool.query(`DELETE FROM payroll_transactions WHERE id = $1`, [originalId]);

    const result = await sync([BASE, { ...OTHER, paid: "Paid" }]);
    expect(result).toMatchObject({ changed: 1, flagged: 1 });
    const { rows: ambiguity } = await pool.query<{
      transaction_id: string | null;
      candidate_count: number;
      candidate_ids: string[];
    }>(
      `SELECT payroll_transaction_id AS transaction_id,
              (previous->>'candidateCount')::int AS candidate_count,
              previous->'candidateTransactionIds' AS candidate_ids
         FROM sheet_sync_conflicts
        WHERE type = 'changed' AND status = 'open'`,
    );
    expect(ambiguity).toHaveLength(1);
    expect(ambiguity[0]!.transaction_id).toBeNull();
    expect(ambiguity[0]!.candidate_count).toBe(2);
    expect([...ambiguity[0]!.candidate_ids].sort()).toEqual([...cloneIds].sort());

    const { rows: tracking } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM sheet_sync_rows
        WHERE payroll_transaction_id = ANY($1::uuid[])`,
      [[...cloneIds]],
    );
    expect(tracking).toEqual([{ count: "0" }]);
  });
});
