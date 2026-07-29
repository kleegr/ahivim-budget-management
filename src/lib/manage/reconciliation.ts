import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { toHours, toMoney } from "@/lib/money";

/**
 * Scheduled-vs-actual reconciliation.
 *
 * A planned session (scheduled_sessions) is matched to an imported transaction
 * (payroll_transactions) for the same individual + program whose pay period
 * contains the session date. The match is a 1:1 link stored on the session
 * (matched_transaction_id, reconciliation_status). Nothing is auto-committed
 * silently — every match/unmatch is audited, and group sessions are surfaced
 * but never auto-matched (their money divides across individuals).
 */

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export interface ReconcileFilter {
  from: string;
  to: string;
  programId?: string;
  individualId?: string;
}

export interface ReconcileBucket {
  count: number;
  hours: string;
  amount: string;
}
export interface ReconciliationSummary {
  matched: ReconcileBucket;
  scheduledNotBilled: ReconcileBucket;
  billedNotScheduled: ReconcileBucket;
}

function sqlFilter(filter: ReconcileFilter): { from: string; to: string; programId: string | null; individualId: string | null } {
  return {
    from: isDate(filter.from) ? filter.from : "1900-01-01",
    to: isDate(filter.to) ? filter.to : "2999-12-31",
    programId: filter.programId && isUuid(filter.programId) ? filter.programId : null,
    individualId: filter.individualId && isUuid(filter.individualId) ? filter.individualId : null,
  };
}

/** The three-way count/hours/amount summary for a date range. */
export async function reconciliationSummary(
  pool: PgLikePool,
  filter: ReconcileFilter,
): Promise<ReconciliationSummary> {
  const f = sqlFilter(filter);

  // Matched + scheduled-not-billed both come from scheduled_sessions. The inner
  // query yields one row per session; the outer groups those into two buckets.
  const sched = await pool.query<{ bucket: string; c: string; hours: string; amount: string }>(
    `SELECT CASE WHEN sub.matched_transaction_id IS NOT NULL THEN 'matched' ELSE 'unbilled' END AS bucket,
            count(*)::text AS c,
            COALESCE(sum(sub.hrs),0)::text AS hours,
            COALESCE(sum(sub.amt),0)::text AS amount
     FROM (
       SELECT s.id, s.matched_transaction_id,
              s.duration_hours AS hrs,
              COALESCE(s.expected_internal_amount,0) AS amt
       FROM scheduled_sessions s
       WHERE s.session_date BETWEEN $1 AND $2
         AND s.status IN ('pending','completed')
         AND ($3::uuid IS NULL OR s.program_id = $3)
         AND ($4::uuid IS NULL OR EXISTS (
               SELECT 1 FROM scheduled_allocations a WHERE a.scheduled_session_id = s.id AND a.individual_id = $4))
     ) sub
     GROUP BY bucket`,
    [f.from, f.to, f.programId, f.individualId],
  );

  // Billed-not-scheduled: transactions in the window not matched to any session.
  const billed = await pool.query<{ c: string; hours: string; amount: string }>(
    `SELECT count(*)::text AS c,
            COALESCE(sum(t.imported_hours),0)::text AS hours,
            COALESCE(sum(t.imported_amount),0)::text AS amount
     FROM payroll_transactions t
     WHERE t.period_begin BETWEEN $1 AND $2
       AND ($3::uuid IS NULL OR t.program_id = $3)
       AND ($4::uuid IS NULL OR t.individual_id = $4)
       AND NOT EXISTS (SELECT 1 FROM scheduled_sessions s WHERE s.matched_transaction_id = t.id)`,
    [f.from, f.to, f.programId, f.individualId],
  );

  const zero: ReconcileBucket = { count: 0, hours: toHours("0"), amount: toMoney("0") };
  const out: ReconciliationSummary = {
    matched: { ...zero },
    scheduledNotBilled: { ...zero },
    billedNotScheduled: { ...zero },
  };
  for (const r of sched.rows) {
    const bucket: ReconcileBucket = { count: Number(r.c), hours: toHours(r.hours), amount: toMoney(r.amount) };
    if (r.bucket === "matched") out.matched = bucket;
    else out.scheduledNotBilled = bucket;
  }
  const b = billed.rows[0];
  if (b) out.billedNotScheduled = { count: Number(b.c), hours: toHours(b.hours), amount: toMoney(b.amount) };
  return out;
}

export interface ScheduledLine {
  id: string;
  sessionDate: string;
  programCode: string;
  individualNames: string[];
  isGroup: boolean;
  hours: string;
  expectedInternal: string | null;
  matchedTransactionId: string | null;
  reconciliationStatus: string | null;
  matchedAmount: string | null;
  matchedHours: string | null;
}

/** Scheduled sessions in range, with their match state (for the work list). */
export async function listScheduledForReconcile(
  pool: PgLikePool,
  filter: ReconcileFilter,
  onlyUnmatched = false,
  limit = 200,
): Promise<ScheduledLine[]> {
  const f = sqlFilter(filter);
  const { rows } = await pool.query<{
    id: string; session_date: string; program_code: string; is_group: boolean;
    duration_hours: string; expected_internal_amount: string | null;
    matched_transaction_id: string | null; reconciliation_status: string | null;
    matched_amount: string | null; matched_hours: string | null;
    individual_names: string[] | null;
  }>(
    `SELECT s.id, s.session_date::text, p.code AS program_code, s.is_group,
            s.duration_hours::text, s.expected_internal_amount::text,
            s.matched_transaction_id, s.reconciliation_status,
            t.imported_amount::text AS matched_amount, t.imported_hours::text AS matched_hours,
            array_agg(i.display_name ORDER BY i.display_name) AS individual_names
     FROM scheduled_sessions s
     JOIN programs p ON p.id = s.program_id
     LEFT JOIN scheduled_allocations a ON a.scheduled_session_id = s.id
     LEFT JOIN individuals i ON i.id = a.individual_id
     LEFT JOIN payroll_transactions t ON t.id = s.matched_transaction_id
     WHERE s.session_date BETWEEN $1 AND $2
       AND s.status IN ('pending','completed')
       AND ($3::uuid IS NULL OR s.program_id = $3)
       AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM scheduled_allocations aa WHERE aa.scheduled_session_id = s.id AND aa.individual_id = $4))
       AND ($5::boolean IS NOT TRUE OR s.matched_transaction_id IS NULL)
     GROUP BY s.id, p.code, t.imported_amount, t.imported_hours
     ORDER BY s.session_date
     LIMIT $6`,
    [f.from, f.to, f.programId, f.individualId, onlyUnmatched, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((r) => ({
    id: r.id,
    sessionDate: r.session_date,
    programCode: r.program_code,
    individualNames: (r.individual_names ?? []).filter(Boolean),
    isGroup: r.is_group,
    hours: toHours(r.duration_hours),
    expectedInternal: r.expected_internal_amount ? toMoney(r.expected_internal_amount) : null,
    matchedTransactionId: r.matched_transaction_id,
    reconciliationStatus: r.reconciliation_status,
    matchedAmount: r.matched_amount ? toMoney(r.matched_amount) : null,
    matchedHours: r.matched_hours ? toHours(r.matched_hours) : null,
  }));
}

export interface BilledLine {
  id: string;
  periodBegin: string | null;
  periodEnd: string | null;
  programCode: string | null;
  individualName: string | null;
  hours: string | null;
  amount: string | null;
}

/** Imported transactions in range with no scheduled match (billed-not-scheduled). */
export async function listBilledNotScheduled(
  pool: PgLikePool,
  filter: ReconcileFilter,
  limit = 200,
): Promise<BilledLine[]> {
  const f = sqlFilter(filter);
  const { rows } = await pool.query<{
    id: string; period_begin: string | null; period_end: string | null; program_code: string | null;
    individual_name: string | null; imported_hours: string | null; imported_amount: string | null;
  }>(
    `SELECT t.id, t.period_begin::text, t.period_end::text, p.code AS program_code,
            i.display_name AS individual_name, t.imported_hours::text, t.imported_amount::text
     FROM payroll_transactions t
     LEFT JOIN programs p ON p.id = t.program_id
     LEFT JOIN individuals i ON i.id = t.individual_id
     WHERE t.period_begin BETWEEN $1 AND $2
       AND ($3::uuid IS NULL OR t.program_id = $3)
       AND ($4::uuid IS NULL OR t.individual_id = $4)
       AND NOT EXISTS (SELECT 1 FROM scheduled_sessions s WHERE s.matched_transaction_id = t.id)
     ORDER BY t.period_begin NULLS LAST
     LIMIT $5`,
    [f.from, f.to, f.programId, f.individualId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((r) => ({
    id: r.id,
    periodBegin: r.period_begin,
    periodEnd: r.period_end,
    programCode: r.program_code,
    individualName: r.individual_name,
    hours: r.imported_hours ? toHours(r.imported_hours) : null,
    amount: r.imported_amount ? toMoney(r.imported_amount) : null,
  }));
}

/** Candidate transactions for a single scheduled session (for manual matching). */
export async function candidatesForSession(
  pool: PgLikePool,
  scheduledSessionId: string,
): Promise<BilledLine[]> {
  if (!isUuid(scheduledSessionId)) return [];
  const { rows } = await pool.query<{
    id: string; period_begin: string | null; period_end: string | null; program_code: string | null;
    individual_name: string | null; imported_hours: string | null; imported_amount: string | null;
  }>(
    `WITH s AS (
       SELECT ss.program_id, ss.session_date,
              (SELECT a.individual_id FROM scheduled_allocations a WHERE a.scheduled_session_id = ss.id LIMIT 1) AS individual_id
       FROM scheduled_sessions ss WHERE ss.id = $1
     )
     SELECT t.id, t.period_begin::text, t.period_end::text, p.code AS program_code,
            i.display_name AS individual_name, t.imported_hours::text, t.imported_amount::text
     FROM s
     JOIN payroll_transactions t
       ON t.individual_id = s.individual_id AND t.program_id = s.program_id
      AND s.session_date BETWEEN t.period_begin AND t.period_end
     LEFT JOIN programs p ON p.id = t.program_id
     LEFT JOIN individuals i ON i.id = t.individual_id
     WHERE NOT EXISTS (SELECT 1 FROM scheduled_sessions x WHERE x.matched_transaction_id = t.id)
     ORDER BY t.period_begin
     LIMIT 25`,
    [scheduledSessionId],
  );
  return rows.map((r) => ({
    id: r.id,
    periodBegin: r.period_begin,
    periodEnd: r.period_end,
    programCode: r.program_code,
    individualName: r.individual_name,
    hours: r.imported_hours ? toHours(r.imported_hours) : null,
    amount: r.imported_amount ? toMoney(r.imported_amount) : null,
  }));
}

/** Link a session to a transaction. Manager or admin. */
export async function manualMatch(
  pool: PgLikePool,
  scheduledSessionId: string,
  transactionId: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(scheduledSessionId)) return fail("not_found", "That session no longer exists.");
  if (!isUuid(transactionId)) return fail("validation", "Choose a transaction to match.");
  const s = await pool.query(`SELECT id FROM scheduled_sessions WHERE id = $1`, [scheduledSessionId]);
  if (!s.rows[0]) return fail("not_found", "That session no longer exists.");
  const t = await pool.query(`SELECT id FROM payroll_transactions WHERE id = $1`, [transactionId]);
  if (!t.rows[0]) return fail("not_found", "That transaction no longer exists.");
  const other = await pool.query<{ id: string }>(
    `SELECT id FROM scheduled_sessions WHERE matched_transaction_id = $1 AND id <> $2`,
    [transactionId, scheduledSessionId],
  );
  if (other.rows[0]) return fail("conflict", "That transaction is already matched to another session.");

  await pool.query(
    `UPDATE scheduled_sessions
       SET matched_transaction_id = $2, reconciliation_status = 'matched',
           reconciled_by_user_id = $3, reconciled_at = now(), reconciliation_reason = $4, updated_at = now()
     WHERE id = $1`,
    [scheduledSessionId, transactionId, actorId, reason ?? null],
  );
  await recordChange(pool, {
    actorId, action: "reconciliation_matched", entityType: "scheduled_session", entityId: scheduledSessionId,
    next: { transactionId }, reason,
  });
  return ok({ id: scheduledSessionId });
}

/** Break an existing match. Manager or admin. */
export async function unmatchSession(
  pool: PgLikePool,
  scheduledSessionId: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(scheduledSessionId)) return fail("not_found", "That session no longer exists.");
  const s = await pool.query<{ matched_transaction_id: string | null }>(
    `SELECT matched_transaction_id FROM scheduled_sessions WHERE id = $1`,
    [scheduledSessionId],
  );
  if (!s.rows[0]) return fail("not_found", "That session no longer exists.");
  await pool.query(
    `UPDATE scheduled_sessions
       SET matched_transaction_id = NULL, reconciliation_status = 'unmatched',
           reconciled_by_user_id = $2, reconciled_at = now(), reconciliation_reason = $3, updated_at = now()
     WHERE id = $1`,
    [scheduledSessionId, actorId, reason ?? null],
  );
  await recordChange(pool, {
    actorId, action: "reconciliation_unmatched", entityType: "scheduled_session", entityId: scheduledSessionId,
    previous: { transactionId: s.rows[0].matched_transaction_id }, reason,
  });
  return ok({ id: scheduledSessionId });
}

/**
 * Auto-link single-individual sessions to the one obvious transaction (same
 * individual + program, session date inside the pay period, transaction not yet
 * used). Conservative: skips group sessions and anything ambiguous. Returns how
 * many were matched.
 */
export async function autoReconcile(
  pool: PgLikePool,
  filter: ReconcileFilter,
  actorId: string | null,
): Promise<Result<{ matched: number; considered: number }>> {
  const f = sqlFilter(filter);
  const { rows: sessions } = await pool.query<{ id: string; program_id: string; session_date: string; individual_id: string }>(
    `SELECT s.id, s.program_id, s.session_date::text,
            (SELECT a.individual_id FROM scheduled_allocations a WHERE a.scheduled_session_id = s.id LIMIT 1) AS individual_id
     FROM scheduled_sessions s
     WHERE s.session_date BETWEEN $1 AND $2
       AND s.status IN ('pending','completed')
       AND s.matched_transaction_id IS NULL
       AND s.is_group = false
       AND ($3::uuid IS NULL OR s.program_id = $3)`,
    [f.from, f.to, f.programId],
  );

  const used = new Set<string>();
  let matched = 0;
  for (const s of sessions) {
    if (!s.individual_id) continue;
    const { rows: cand } = await pool.query<{ id: string }>(
      `SELECT t.id FROM payroll_transactions t
       WHERE t.individual_id = $1 AND t.program_id = $2
         AND $3 BETWEEN t.period_begin AND t.period_end
         AND NOT EXISTS (SELECT 1 FROM scheduled_sessions x WHERE x.matched_transaction_id = t.id)
       ORDER BY t.period_begin
       LIMIT 5`,
      [s.individual_id, s.program_id, s.session_date],
    );
    const pick = cand.find((c) => !used.has(c.id));
    if (!pick) continue;
    used.add(pick.id);
    await pool.query(
      `UPDATE scheduled_sessions
         SET matched_transaction_id = $2, reconciliation_status = 'matched',
             reconciled_by_user_id = $3, reconciled_at = now(),
             reconciliation_reason = 'auto-matched', updated_at = now()
       WHERE id = $1`,
      [s.id, pick.id, actorId],
    );
    matched += 1;
  }
  if (matched > 0) {
    await recordChange(pool, {
      actorId, action: "reconciliation_auto", entityType: "scheduled_session", entityId: null,
      next: { matched, considered: sessions.length, range: `${f.from}..${f.to}` },
      reason: "auto-reconcile",
    });
  }
  return ok({ matched, considered: sessions.length });
}
