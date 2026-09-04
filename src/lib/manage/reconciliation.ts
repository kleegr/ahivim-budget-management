import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { toHours, toMoney, closeEnough } from "@/lib/money";

/**
 * Scheduled-vs-actual reconciliation.
 *
 * A planned session (scheduled_sessions) is matched to an imported transaction
 * (payroll_transactions) for the same individual + program whose pay period
 * contains the session date. The match is a 1:1 link stored on the session
 * (matched_transaction_id, reconciliation_status). Only exact daily facts may
 * auto-match, every match/unmatch is audited, and pay-period aggregates,
 * ambiguous records, and group sessions remain available for human review.
 */

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const ONE_TRANSACTION_MATCH_INDEX = "scheduled_sessions_one_transaction_match_key";

function isTransactionMatchConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const databaseError = error as { code?: unknown; constraint?: unknown };
  return databaseError.code === "23505" && databaseError.constraint === ONE_TRANSACTION_MATCH_INDEX;
}
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
     WHERE canonical_service_date(t.period_begin, t.check_date, t.period_end) BETWEEN $1 AND $2
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
  serviceDate: string | null;
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
    id: string; service_date: string | null; period_begin: string | null; period_end: string | null; program_code: string | null;
    individual_name: string | null; imported_hours: string | null; imported_amount: string | null;
  }>(
    `SELECT t.id,
            canonical_service_date(t.period_begin, t.check_date, t.period_end)::text AS service_date,
            t.period_begin::text, t.period_end::text, p.code AS program_code,
            i.display_name AS individual_name, t.imported_hours::text, t.imported_amount::text
     FROM payroll_transactions t
     LEFT JOIN programs p ON p.id = t.program_id
     LEFT JOIN individuals i ON i.id = t.individual_id
     WHERE canonical_service_date(t.period_begin, t.check_date, t.period_end) BETWEEN $1 AND $2
       AND ($3::uuid IS NULL OR t.program_id = $3)
       AND ($4::uuid IS NULL OR t.individual_id = $4)
       AND NOT EXISTS (SELECT 1 FROM scheduled_sessions s WHERE s.matched_transaction_id = t.id)
     ORDER BY canonical_service_date(t.period_begin, t.check_date, t.period_end) NULLS LAST
     LIMIT $5`,
    [f.from, f.to, f.programId, f.individualId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((r) => ({
    id: r.id,
    serviceDate: r.service_date,
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
    id: string; service_date: string | null; period_begin: string | null; period_end: string | null; program_code: string | null;
    individual_name: string | null; imported_hours: string | null; imported_amount: string | null;
  }>(
    `WITH s AS (
       SELECT ss.program_id, ss.session_date,
              (SELECT a.individual_id FROM scheduled_allocations a WHERE a.scheduled_session_id = ss.id LIMIT 1) AS individual_id
       FROM scheduled_sessions ss WHERE ss.id = $1
     )
     SELECT t.id,
            canonical_service_date(t.period_begin, t.check_date, t.period_end)::text AS service_date,
            t.period_begin::text, t.period_end::text, p.code AS program_code,
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
    serviceDate: r.service_date,
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sessionResult = await client.query<{
      id: string;
      program_id: string;
      session_date: string;
      is_group: boolean;
      matched_transaction_id: string | null;
    }>(
      `SELECT id, program_id, session_date::text, is_group, matched_transaction_id
         FROM scheduled_sessions
        WHERE id = $1
        FOR UPDATE`,
      [scheduledSessionId],
    );
    const session = sessionResult.rows[0];
    if (!session) {
      await client.query("ROLLBACK");
      return fail("not_found", "That session no longer exists.");
    }
    if (session.matched_transaction_id && session.matched_transaction_id !== transactionId) {
      await client.query("ROLLBACK");
      return fail("conflict", "Remove the session's current match before choosing another transaction.");
    }

    const allocations = await client.query<{ individual_id: string }>(
      `SELECT individual_id
         FROM scheduled_allocations
        WHERE scheduled_session_id = $1
        ORDER BY individual_id`,
      [scheduledSessionId],
    );
    if (session.is_group || allocations.rows.length !== 1) {
      await client.query("ROLLBACK");
      return fail("validation", "Group visits stay in Group review and cannot be linked to one transaction.");
    }

    // Lock the source row before checking ownership. This makes concurrent
    // manual matches serialize on the transaction; the unique index remains
    // the final protection against auto-match races.
    const transactionResult = await client.query<{
      id: string;
      individual_id: string | null;
      program_id: string | null;
      period_begin: string | null;
      period_end: string | null;
    }>(
      `SELECT id, individual_id, program_id, period_begin::text, period_end::text
         FROM payroll_transactions
        WHERE id = $1
        FOR UPDATE`,
      [transactionId],
    );
    const transaction = transactionResult.rows[0];
    if (!transaction) {
      await client.query("ROLLBACK");
      return fail("not_found", "That transaction no longer exists.");
    }

    const individualId = allocations.rows[0]!.individual_id;
    if (transaction.individual_id !== individualId || transaction.program_id !== session.program_id) {
      await client.query("ROLLBACK");
      return fail("validation", "Choose a transaction for this visit's individual and program.");
    }
    if (
      !transaction.period_begin
      || !transaction.period_end
      || session.session_date < transaction.period_begin
      || session.session_date > transaction.period_end
    ) {
      await client.query("ROLLBACK");
      return fail("validation", "Choose a transaction whose service period includes this visit date.");
    }

    const other = await client.query<{ id: string }>(
      `SELECT id
         FROM scheduled_sessions
        WHERE matched_transaction_id = $1 AND id <> $2
        FOR UPDATE`,
      [transactionId, scheduledSessionId],
    );
    if (other.rows[0]) {
      await client.query("ROLLBACK");
      return fail("conflict", "That transaction is already matched to another session.");
    }

    await client.query(
      `UPDATE scheduled_sessions
         SET matched_transaction_id = $2, reconciliation_status = 'matched',
             reconciled_by_user_id = $3, reconciled_at = now(), reconciliation_reason = $4, updated_at = now()
       WHERE id = $1`,
      [scheduledSessionId, transactionId, actorId, reason ?? null],
    );
    await recordChange(client, {
      actorId, action: "reconciliation_matched", entityType: "scheduled_session", entityId: scheduledSessionId,
      next: { transactionId }, reason,
    });
    await client.query("COMMIT");
    return ok({ id: scheduledSessionId });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isTransactionMatchConflict(error)) {
      return fail("conflict", "That transaction is already matched to another session.");
    }
    throw error;
  } finally {
    client.release();
  }
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

interface AutoMatchSession {
  id: string;
  program_id: string;
  session_date: string;
  individual_id: string | null;
  allocation_count: number;
  employee_id: string | null;
  duration_hours: string;
  is_group: boolean;
  group_size: number;
}

interface AutoMatchCandidate {
  id: string;
  employee_id: string | null;
  imported_hours: string | null;
  period_begin: string | null;
  period_end: string | null;
  is_group_service: boolean;
}

function isExactDailyCandidate(session: AutoMatchSession, candidate: AutoMatchCandidate): boolean {
  return session.allocation_count === 1
    && session.is_group === false
    && session.group_size === 1
    && session.individual_id !== null
    && session.employee_id !== null
    && candidate.employee_id === session.employee_id
    && candidate.imported_hours !== null
    && closeEnough(candidate.imported_hours, session.duration_hours, "0")
    && candidate.period_begin === session.session_date
    && candidate.period_end === session.session_date
    && candidate.is_group_service === false;
}

/**
 * Auto-link only a transaction that proves it represents one planned visit:
 * one individual, the same employee and program, exact hours, and a one-day
 * service period equal to the visit date. Pay-period aggregates and group rows
 * remain unmatched for human review. Ambiguity on either side also prevents a
 * match.
 */
export async function autoReconcile(
  pool: PgLikePool,
  filter: ReconcileFilter,
  actorId: string | null,
): Promise<Result<{ matched: number; considered: number }>> {
  const f = sqlFilter(filter);
  const { rows: sessions } = await pool.query<AutoMatchSession>(
    `SELECT s.id, s.program_id, s.session_date::text, s.employee_id,
            s.duration_hours::text, s.is_group, s.group_size,
            (SELECT a.individual_id FROM scheduled_allocations a WHERE a.scheduled_session_id = s.id LIMIT 1) AS individual_id,
            (SELECT count(*)::int FROM scheduled_allocations a WHERE a.scheduled_session_id = s.id) AS allocation_count
     FROM scheduled_sessions s
     WHERE s.session_date BETWEEN $1 AND $2
       AND s.status IN ('pending','completed')
       AND s.archived_at IS NULL
       AND s.matched_transaction_id IS NULL
       AND s.is_group = false
       AND s.group_size = 1
       AND ($3::uuid IS NULL OR s.program_id = $3)
       AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM scheduled_allocations a
              WHERE a.scheduled_session_id = s.id AND a.individual_id = $4))`,
    [f.from, f.to, f.programId, f.individualId],
  );

  const candidatesBySession = new Map<string, string[]>();
  const sessionsByCandidate = new Map<string, Set<string>>();
  let considered = 0;
  for (const session of sessions) {
    if (
      !session.individual_id
      || !session.employee_id
      || session.allocation_count !== 1
      || session.is_group
      || session.group_size !== 1
    ) continue;
    considered += 1;
    const { rows: possibleCandidates } = await pool.query<AutoMatchCandidate>(
      `SELECT t.id, t.employee_id, t.imported_hours::text,
              t.period_begin::text, t.period_end::text, t.is_group_service
         FROM payroll_transactions t
       WHERE t.individual_id = $1 AND t.program_id = $2
         AND t.period_begin = $3::date AND t.period_end = $3::date
         AND t.employee_id = $4
         AND t.imported_hours = $5::numeric
         AND t.is_group_service = false
         AND NOT EXISTS (SELECT 1 FROM scheduled_sessions x WHERE x.matched_transaction_id = t.id)
       ORDER BY t.id
       LIMIT 2`,
      [
        session.individual_id,
        session.program_id,
        session.session_date,
        session.employee_id,
        session.duration_hours,
      ],
    );
    const candidates = possibleCandidates.filter((candidate) => isExactDailyCandidate(session, candidate));
    const ids = candidates.map((candidate) => candidate.id);
    candidatesBySession.set(session.id, ids);
    for (const candidateId of ids) {
      const sessionIds = sessionsByCandidate.get(candidateId) ?? new Set<string>();
      sessionIds.add(session.id);
      sessionsByCandidate.set(candidateId, sessionIds);
    }
  }

  let matched = 0;
  for (const s of sessions) {
    const candidates = candidatesBySession.get(s.id) ?? [];
    if (candidates.length !== 1) continue;
    const candidateId = candidates[0]!;
    if (sessionsByCandidate.get(candidateId)?.size !== 1) continue;
    try {
      const { rows: updated } = await pool.query<{ id: string }>(
        `UPDATE scheduled_sessions
           SET matched_transaction_id = $2, reconciliation_status = 'matched',
               reconciled_by_user_id = $3, reconciled_at = now(),
               reconciliation_reason = 'auto-matched', updated_at = now()
         WHERE id = $1
           AND matched_transaction_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM scheduled_sessions claimed WHERE claimed.matched_transaction_id = $2
           )
         RETURNING id`,
        [s.id, candidateId, actorId],
      );
      if (updated.length === 1) matched += 1;
    } catch (error) {
      // The partial unique index is the final arbiter when two matching runs race.
      if (isTransactionMatchConflict(error)) continue;
      throw error;
    }
  }
  if (matched > 0) {
    await recordChange(pool, {
      actorId, action: "reconciliation_auto", entityType: "scheduled_session", entityId: null,
      next: { matched, considered, range: `${f.from}..${f.to}` },
      reason: "auto-reconcile",
    });
  }
  return ok({ matched, considered });
}

/* -------------------------------------------------------------------------- */
/* Match classification + duplicate detection (detailed reconciliation)       */
/* -------------------------------------------------------------------------- */

/**
 * How well a scheduled session and its matched transaction agree.
 *   exact             program, employee, hours and amount all line up.
 *   hours_mismatch    only the hours differ.
 *   amount_mismatch   only the money differs.
 *   employee_mismatch a different employee actually billed.
 *   program_mismatch  a different program was billed.
 *   probable          the right pair, but both hours AND money differ (e.g. a
 *                     rate change) — a likely match worth a human glance.
 */
export type MatchLabel =
  | "exact"
  | "hours_mismatch"
  | "amount_mismatch"
  | "employee_mismatch"
  | "program_mismatch"
  | "probable";

export const MATCH_LABELS: readonly MatchLabel[] = [
  "exact",
  "hours_mismatch",
  "amount_mismatch",
  "employee_mismatch",
  "program_mismatch",
  "probable",
] as const;

export interface MatchScheduled {
  durationHours: string | null;
  expectedInternalAmount: string | null;
  employeeId: string | null;
  programId: string | null;
}
export interface MatchTransaction {
  importedHours: string | null;
  importedAmount: string | null;
  employeeId: string | null;
  programId: string | null;
}

/** Both values present and further apart than the tolerance. Missing data never flags. */
function differs(a: string | null, b: string | null, tolerance: string): boolean {
  if (a === null || b === null) return false;
  return !closeEnough(a, b, tolerance);
}

/**
 * Classify a scheduled↔transaction pair. Pure: hours/amount within $0.01 /
 * 0.01h are treated as equal, ids compared only when both are known. Program
 * and employee differences dominate a numeric one because they mean a
 * different service was billed, not merely a different figure.
 */
export function classifyMatch(scheduled: MatchScheduled, transaction: MatchTransaction): MatchLabel {
  if (
    scheduled.programId &&
    transaction.programId &&
    scheduled.programId !== transaction.programId
  ) {
    return "program_mismatch";
  }
  if (
    scheduled.employeeId &&
    transaction.employeeId &&
    scheduled.employeeId !== transaction.employeeId
  ) {
    return "employee_mismatch";
  }
  const hoursDiff = differs(scheduled.durationHours, transaction.importedHours, "0.01");
  const amountDiff = differs(scheduled.expectedInternalAmount, transaction.importedAmount, "0.01");
  if (hoursDiff && amountDiff) return "probable";
  if (hoursDiff) return "hours_mismatch";
  if (amountDiff) return "amount_mismatch";
  return "exact";
}

export interface MatchedDetail {
  sessionId: string;
  transactionId: string;
  sessionDate: string;
  programCode: string | null;
  individualNames: string[];
  isGroup: boolean;
  scheduledHours: string;
  scheduledAmount: string | null;
  matchedHours: string | null;
  matchedAmount: string | null;
  label: MatchLabel;
}

export interface DuplicateGroup {
  reason: "fingerprint" | "composite";
  count: number;
  transactionIds: string[];
  individualName: string | null;
  programCode: string | null;
  amount: string | null;
}

export interface ReconciliationDetail {
  matched: MatchedDetail[];
  labelCounts: Record<MatchLabel, number>;
  duplicates: DuplicateGroup[];
}

/**
 * For every matched session in range, the pair and its classifyMatch label,
 * plus transactions that look duplicated (same fingerprint, or the same
 * individual+program+period+amount appearing more than once).
 */
export async function reconciliationDetail(
  pool: PgLikePool,
  filter: ReconcileFilter,
): Promise<ReconciliationDetail> {
  const f = sqlFilter(filter);

  const { rows: matchedRows } = await pool.query<{
    session_id: string;
    session_date: string;
    program_code: string | null;
    is_group: boolean;
    duration_hours: string;
    expected_internal_amount: string | null;
    s_employee_id: string | null;
    s_program_id: string | null;
    transaction_id: string;
    imported_hours: string | null;
    imported_amount: string | null;
    t_employee_id: string | null;
    t_program_id: string | null;
    individual_names: string[] | null;
  }>(
    `SELECT s.id AS session_id, s.session_date::text, p.code AS program_code, s.is_group,
            s.duration_hours::text, s.expected_internal_amount::text,
            s.employee_id AS s_employee_id, s.program_id AS s_program_id,
            t.id AS transaction_id, t.imported_hours::text, t.imported_amount::text,
            t.employee_id AS t_employee_id, t.program_id AS t_program_id,
            array_agg(i.display_name ORDER BY i.display_name)
              FILTER (WHERE i.id IS NOT NULL) AS individual_names
     FROM scheduled_sessions s
     JOIN payroll_transactions t ON t.id = s.matched_transaction_id
     LEFT JOIN programs p ON p.id = s.program_id
     LEFT JOIN scheduled_allocations a ON a.scheduled_session_id = s.id
     LEFT JOIN individuals i ON i.id = a.individual_id
     WHERE s.session_date BETWEEN $1 AND $2
       AND s.status IN ('pending','completed')
       AND ($3::uuid IS NULL OR s.program_id = $3)
       AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM scheduled_allocations aa
             WHERE aa.scheduled_session_id = s.id AND aa.individual_id = $4))
     GROUP BY s.id, p.code, t.id
     ORDER BY s.session_date
     LIMIT 500`,
    [f.from, f.to, f.programId, f.individualId],
  );

  const labelCounts: Record<MatchLabel, number> = {
    exact: 0,
    hours_mismatch: 0,
    amount_mismatch: 0,
    employee_mismatch: 0,
    program_mismatch: 0,
    probable: 0,
  };

  const matched: MatchedDetail[] = matchedRows.map((r) => {
    const label = classifyMatch(
      {
        durationHours: r.duration_hours,
        expectedInternalAmount: r.expected_internal_amount,
        employeeId: r.s_employee_id,
        programId: r.s_program_id,
      },
      {
        importedHours: r.imported_hours,
        importedAmount: r.imported_amount,
        employeeId: r.t_employee_id,
        programId: r.t_program_id,
      },
    );
    labelCounts[label] += 1;
    return {
      sessionId: r.session_id,
      transactionId: r.transaction_id,
      sessionDate: r.session_date,
      programCode: r.program_code,
      individualNames: (r.individual_names ?? []).filter(Boolean),
      isGroup: r.is_group,
      scheduledHours: toHours(r.duration_hours),
      scheduledAmount: r.expected_internal_amount ? toMoney(r.expected_internal_amount) : null,
      matchedHours: r.imported_hours ? toHours(r.imported_hours) : null,
      matchedAmount: r.imported_amount ? toMoney(r.imported_amount) : null,
      label,
    };
  });

  const duplicates = await findDuplicateTransactions(pool, f);
  return { matched, labelCounts, duplicates };
}

/**
 * Transactions that appear more than once in the window, by two definitions:
 * an identical fingerprint, and the same individual+program+period+amount. The
 * two lists are merged so an identical set of ids is reported once, fingerprint
 * taking precedence because it is the stronger signal.
 */
async function findDuplicateTransactions(
  pool: PgLikePool,
  f: { from: string; to: string; programId: string | null; individualId: string | null },
): Promise<DuplicateGroup[]> {
  const byFingerprint = await pool.query<{
    c: number;
    ids: string[];
    individual_name: string | null;
    program_code: string | null;
    amount: string | null;
  }>(
    `SELECT count(*)::int AS c,
            array_agg(t.id::text ORDER BY t.id) AS ids,
            max(i.display_name) AS individual_name,
            max(p.code) AS program_code,
            max(t.imported_amount)::text AS amount
     FROM payroll_transactions t
     LEFT JOIN individuals i ON i.id = t.individual_id
     LEFT JOIN programs p ON p.id = t.program_id
     WHERE canonical_service_date(t.period_begin, t.check_date, t.period_end) BETWEEN $1 AND $2
       AND ($3::uuid IS NULL OR t.program_id = $3)
       AND ($4::uuid IS NULL OR t.individual_id = $4)
     GROUP BY t.transaction_fingerprint
     HAVING count(*) > 1
     ORDER BY count(*) DESC
     LIMIT 200`,
    [f.from, f.to, f.programId, f.individualId],
  );

  const byComposite = await pool.query<{
    c: number;
    ids: string[];
    individual_name: string | null;
    program_code: string | null;
    amount: string | null;
  }>(
    `SELECT count(*)::int AS c,
            array_agg(t.id::text ORDER BY t.id) AS ids,
            max(i.display_name) AS individual_name,
            max(p.code) AS program_code,
            t.imported_amount::text AS amount
     FROM payroll_transactions t
     LEFT JOIN individuals i ON i.id = t.individual_id
     LEFT JOIN programs p ON p.id = t.program_id
     WHERE canonical_service_date(t.period_begin, t.check_date, t.period_end) BETWEEN $1 AND $2
       AND ($3::uuid IS NULL OR t.program_id = $3)
       AND ($4::uuid IS NULL OR t.individual_id = $4)
       AND t.individual_id IS NOT NULL AND t.program_id IS NOT NULL
     GROUP BY t.individual_id, t.program_id, t.period_begin, t.period_end,
              canonical_service_date(t.period_begin, t.check_date, t.period_end),
              t.imported_amount
     HAVING count(*) > 1
     ORDER BY count(*) DESC
     LIMIT 200`,
    [f.from, f.to, f.programId, f.individualId],
  );

  const out: DuplicateGroup[] = [];
  const seen = new Set<string>();
  const add = (reason: DuplicateGroup["reason"], rows: typeof byFingerprint.rows) => {
    for (const r of rows) {
      const ids = (r.ids ?? []).slice().sort();
      const key = ids.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        reason,
        count: Number(r.c),
        transactionIds: ids,
        individualName: r.individual_name,
        programCode: r.program_code,
        amount: r.amount != null ? toMoney(r.amount) : null,
      });
    }
  };
  add("fingerprint", byFingerprint.rows);
  add("composite", byComposite.rows);
  return out;
}
