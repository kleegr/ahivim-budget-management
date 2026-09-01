import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { dec, toMoney, toHours, closeEnough } from "@/lib/money";

/**
 * Group-detection review.
 *
 * The importer already writes a service_session for every physical occurrence
 * and, when it detects a multi-individual group, records the combined rate /
 * amount, the base individual rate, the group size and a detection status.
 * This module SURFACES those candidates for a human to confirm or reject. It
 * never fabricates an allocation: the split the importer wrote is shown exactly
 * as stored, together with a money-conservation check that says whether the
 * per-individual amounts still add back up to the combined amount and whether
 * the combined rate is what the group size and base rate imply.
 *
 * Money is summed in SQL and compared with decimal.js at a $0.01 tolerance;
 * nothing here is a JavaScript float.
 */

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

/** The four states group_detection_status can hold. */
export const GROUP_STATUSES = ["single", "detected", "needs_review", "confirmed"] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

/** Statuses setGroupStatus may write: confirm, reject (back to single), review. */
const SETTABLE_STATUSES = new Set<GroupStatus>(["confirmed", "needs_review", "single"]);

/** The money tolerance for reconciling a split back to its combined amount. */
const CENT = "0.01";

export interface GroupMember {
  individualId: string;
  name: string;
  allocationHours: string;
  allocatedAmount: string;
  allocatedRate: string | null;
}

export interface GroupCandidate {
  id: string;
  programCode: string | null;
  programName: string | null;
  employeeName: string | null;
  periodBegin: string | null;
  periodEnd: string | null;
  physicalHours: string;
  groupSize: number;
  combinedRate: string | null;
  combinedAmount: string | null;
  baseIndividualRate: string | null;
  detectionRule: string | null;
  confidence: string | null;
  status: string;
  members: GroupMember[];
  memberCount: number;
  /** sum(allocated_amount) across the members, summed in SQL. */
  allocatedSum: string;
  /** Does the per-individual money add back to combined_amount (± $0.01)? */
  moneyReconciles: boolean;
  /** group_size × base_individual_rate, or null when the base rate is unknown. */
  expectedCombinedRate: string | null;
  /** Is combined_rate what the group size and base rate imply (± $0.01)? */
  rateConsistent: boolean;
  /** Does the number of member allocations equal the recorded group size? */
  memberCountMatches: boolean;
}

export type GroupClassification =
  | "confirmed"
  | "probable"
  | "not_a_group"
  | "requires_review";

/** The minimal shape classifyGroupCandidate reasons over (a GroupCandidate qualifies). */
export interface GroupClassificationInput {
  groupSize: number;
  moneyReconciles: boolean;
  memberCountMatches: boolean;
  rateConsistent: boolean;
}

/**
 * Classify a detected candidate WITHOUT touching the database, so the same
 * verdict can be unit-tested and shown in the UI:
 *
 *   not_a_group      the session is not multi-individual (group_size <= 1).
 *   requires_review  the money does not reconcile — the split cannot be trusted.
 *   confirmed        money reconciles AND the member count and rate math agree.
 *   probable         money reconciles but one of the other checks disagrees
 *                    (most-but-not-all: a likely group needing a glance).
 */
export function classifyGroupCandidate(c: GroupClassificationInput): GroupClassification {
  if (c.groupSize <= 1) return "not_a_group";
  if (!c.moneyReconciles) return "requires_review";
  if (c.memberCountMatches && c.rateConsistent) return "confirmed";
  return "probable";
}

/**
 * Candidates the importer already flagged: every session with more than one
 * individual, or whose detection status is anything other than a plain single.
 * Optionally narrowed to one status.
 */
export async function listGroupCandidates(
  pool: PgLikePool,
  options: { status?: string; sessionId?: string } = {},
  limit = 200,
): Promise<GroupCandidate[]> {
  const status =
    options.status && (GROUP_STATUSES as readonly string[]).includes(options.status)
      ? options.status
      : null;
  const sessionId = options.sessionId && isUuid(options.sessionId) ? options.sessionId : null;
  const cap = Math.min(Math.max(limit, 1), 500);

  const { rows } = await pool.query<{
    id: string;
    program_code: string | null;
    program_name: string | null;
    employee_name: string | null;
    period_begin: string | null;
    period_end: string | null;
    physical_hours: string;
    group_size: number;
    combined_rate: string | null;
    combined_amount: string | null;
    base_individual_rate: string | null;
    detection_rule: string | null;
    confidence: string | null;
    group_detection_status: string;
    member_count: number;
    allocated_sum: string;
  }>(
    `SELECT ss.id,
            p.code AS program_code, p.name AS program_name,
            e.display_name AS employee_name,
            ss.period_begin::text, ss.period_end::text,
            ss.physical_hours::text,
            ss.group_size,
            ss.combined_rate::text, ss.combined_amount::text, ss.base_individual_rate::text,
            ss.detection_rule, ss.confidence::text, ss.group_detection_status,
            COALESCE(sa.member_count, 0) AS member_count,
            COALESCE(sa.allocated_sum, '0') AS allocated_sum
     FROM service_sessions ss
     LEFT JOIN programs p ON p.id = ss.program_id
     LEFT JOIN employees e ON e.id = ss.employee_id
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS member_count,
              COALESCE(sum(a.allocated_amount), 0)::text AS allocated_sum
       FROM service_allocations a
       WHERE a.service_session_id = ss.id
     ) sa ON true
     WHERE (ss.group_size > 1
            OR ss.group_detection_status IN ('detected', 'needs_review', 'confirmed'))
       AND ($1::text IS NULL OR ss.group_detection_status = $1)
       AND ($2::uuid IS NULL OR ss.id = $2)
     ORDER BY ss.period_begin NULLS LAST, ss.id
     LIMIT $3`,
    [status, sessionId, cap],
  );

  if (rows.length === 0) return [];

  // One extra query for the members of every candidate, keyed by session id, so
  // the list is two round-trips rather than one per row.
  const ids = rows.map((r) => r.id);
  const { rows: memberRows } = await pool.query<{
    service_session_id: string;
    individual_id: string;
    display_name: string;
    allocation_hours: string;
    allocated_amount: string;
    allocated_rate: string | null;
  }>(
    `SELECT a.service_session_id, i.id AS individual_id, i.display_name,
            a.allocation_hours::text, a.allocated_amount::text, a.allocated_rate::text
     FROM service_allocations a
     JOIN individuals i ON i.id = a.individual_id
     WHERE a.service_session_id = ANY($1::uuid[])
     ORDER BY i.display_name`,
    [ids],
  );

  const membersBySession = new Map<string, GroupMember[]>();
  for (const m of memberRows) {
    const list = membersBySession.get(m.service_session_id) ?? [];
    list.push({
      individualId: m.individual_id,
      name: m.display_name,
      allocationHours: toHours(m.allocation_hours),
      allocatedAmount: toMoney(m.allocated_amount),
      allocatedRate: m.allocated_rate != null ? toMoney(m.allocated_rate) : null,
    });
    membersBySession.set(m.service_session_id, list);
  }

  return rows.map((r) => {
    const groupSize = Number(r.group_size);
    const memberCount = Number(r.member_count);
    const allocatedSum = toMoney(r.allocated_sum);

    const moneyReconciles =
      r.combined_amount != null && closeEnough(allocatedSum, r.combined_amount, CENT);

    const expectedCombinedRate =
      r.base_individual_rate != null
        ? toMoney(dec(r.base_individual_rate).times(groupSize))
        : null;
    const rateConsistent =
      r.combined_rate != null &&
      expectedCombinedRate != null &&
      closeEnough(r.combined_rate, expectedCombinedRate, CENT);

    return {
      id: r.id,
      programCode: r.program_code,
      programName: r.program_name,
      employeeName: r.employee_name,
      periodBegin: r.period_begin,
      periodEnd: r.period_end,
      physicalHours: toHours(r.physical_hours),
      groupSize,
      combinedRate: r.combined_rate != null ? toMoney(r.combined_rate) : null,
      combinedAmount: r.combined_amount != null ? toMoney(r.combined_amount) : null,
      baseIndividualRate: r.base_individual_rate != null ? toMoney(r.base_individual_rate) : null,
      detectionRule: r.detection_rule,
      confidence: r.confidence,
      status: r.group_detection_status,
      members: membersBySession.get(r.id) ?? [],
      memberCount,
      allocatedSum,
      moneyReconciles,
      expectedCombinedRate,
      rateConsistent,
      memberCountMatches: memberCount === groupSize,
    };
  });
}

/**
 * Record a human's decision about a detected group: confirm it, send it back
 * for review, or reject it (back to a plain single session). The allocations
 * themselves are untouched — only the status moves — and the change is audited.
 * Manager or admin.
 */
export async function setGroupStatus(
  pool: PgLikePool,
  serviceSessionId: string,
  status: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string; status: string }>> {
  if (!isUuid(serviceSessionId)) return fail("not_found", "That session no longer exists.");
  if (!SETTABLE_STATUSES.has(status as GroupStatus)) {
    return fail("validation", "Choose confirm, review, or reject.");
  }
  const { rows } = await pool.query<{ group_detection_status: string }>(
    `SELECT group_detection_status FROM service_sessions WHERE id = $1`,
    [serviceSessionId],
  );
  if (!rows[0]) return fail("not_found", "That session no longer exists.");

  await pool.query(
    `UPDATE service_sessions SET group_detection_status = $2, updated_at = now() WHERE id = $1`,
    [serviceSessionId, status],
  );
  await recordChange(pool, {
    actorId,
    action: "group_detection_status",
    entityType: "service_session",
    entityId: serviceSessionId,
    previous: { status: rows[0].group_detection_status },
    next: { status },
    reason,
  });
  return ok({ id: serviceSessionId, status });
}
