import type { AccessScope } from "@/lib/auth/access";
import type { PgLikePool } from "@/lib/import/commit";
import { toHours } from "@/lib/money";

export type PlanningMatchReason = "group" | "none" | "possible" | "pay_period" | "multiple";

/** Money-free reconciliation facts for the planning workspace. */
export interface PlanningMatchReviewRow {
  id: string;
  sessionDate: string;
  employeeId: string | null;
  employeeName: string | null;
  programId: string;
  programCode: string;
  programName: string;
  individualIds: string[];
  individualNames: string[];
  plannedHours: string;
  isGroup: boolean;
  groupSize: number;
  candidateCount: number;
  candidateHours: string;
  hasPayPeriodCandidates: boolean;
  reason: PlanningMatchReason;
}

export interface PlanningMatchReview {
  rows: PlanningMatchReviewRow[];
  total: number;
  groupCount: number;
  multipleCount: number;
  noCandidateCount: number;
}

export function emptyPlanningMatchReview(): PlanningMatchReview {
  return {
    rows: [],
    total: 0,
    groupCount: 0,
    multipleCount: 0,
    noCandidateCount: 0,
  };
}

function scopeArrays(scope: AccessScope): [string[] | null, string[] | null] {
  return [
    scope.full || scope.allIndividuals ? null : scope.individualIds,
    scope.full || scope.allEmployees ? null : scope.employeeIds,
  ];
}

/**
 * Past planned sessions that still have no confirmed recorded-service match.
 * Candidate data is intentionally limited to counts and hours; no transaction
 * identifiers, check information, rates, or amounts leave this read model.
 */
export async function getPlanningMatchReview(
  pool: PgLikePool,
  asOf: string,
  scope: AccessScope,
  agencyIds: string[] = [],
  limit = 200,
): Promise<PlanningMatchReview> {
  const [individualIds, employeeIds] = scopeArrays(scope);
  const scopedAgencyIds = agencyIds.length > 0 ? agencyIds : null;
  const { rows } = await pool.query<{
    id: string;
    session_date: string;
    employee_id: string | null;
    employee_name: string | null;
    program_id: string;
    program_code: string;
    program_name: string;
    individual_ids: string[] | null;
    individual_names: string[] | null;
    duration_hours: string;
    is_group: boolean;
    group_size: number;
    candidate_count: string;
    candidate_hours: string;
    pay_period_candidate_count: string;
    total_count: string;
    total_group_count: string;
    total_multiple_count: string;
    total_no_candidate_count: string;
  }>(
    `SELECT session.id, session.session_date::text,
            session.employee_id, employee.display_name AS employee_name,
            session.program_id, program.code AS program_code, program.name AS program_name,
            participants.individual_ids, participants.individual_names,
            session.duration_hours::text, session.is_group, session.group_size,
            candidates.candidate_count, candidates.candidate_hours,
            candidates.pay_period_candidate_count,
            count(*) OVER()::text AS total_count,
            (count(*) FILTER (WHERE session.is_group) OVER())::text AS total_group_count,
            (count(*) FILTER (
              WHERE session.is_group = false AND candidates.candidate_count::int > 1
            ) OVER())::text AS total_multiple_count,
            (count(*) FILTER (
              WHERE session.is_group = false AND candidates.candidate_count::int = 0
            ) OVER())::text AS total_no_candidate_count
       FROM scheduled_sessions session
       LEFT JOIN employees employee ON employee.id = session.employee_id
       JOIN programs program ON program.id = session.program_id
       JOIN LATERAL (
         SELECT array_agg(allocation.individual_id::text ORDER BY individual.display_name) AS individual_ids,
                array_agg(individual.display_name ORDER BY individual.display_name) AS individual_names
           FROM scheduled_allocations allocation
           JOIN individuals individual ON individual.id = allocation.individual_id
          WHERE allocation.scheduled_session_id = session.id
       ) participants ON cardinality(participants.individual_ids) > 0
       LEFT JOIN LATERAL (
         SELECT count(*)::text AS candidate_count,
                COALESCE(sum(actual.imported_hours), 0)::text AS candidate_hours,
                count(*) FILTER (
                  WHERE actual.period_begin IS NOT NULL
                    AND actual.period_end IS NOT NULL
                    AND actual.period_begin <> actual.period_end
                )::text AS pay_period_candidate_count
           FROM payroll_transactions actual
          WHERE actual.program_id = session.program_id
            AND (
              (actual.period_begin IS NOT NULL AND actual.period_end IS NOT NULL
                AND session.session_date BETWEEN actual.period_begin AND actual.period_end)
              OR ((actual.period_begin IS NULL OR actual.period_end IS NULL)
                AND canonical_service_date(
                  actual.period_begin, actual.check_date, actual.period_end
                ) = session.session_date)
            )
            AND (session.employee_id IS NULL OR actual.employee_id = session.employee_id)
            AND EXISTS (
              SELECT 1
                FROM scheduled_allocations participant
               WHERE participant.scheduled_session_id = session.id
                 AND participant.individual_id = actual.individual_id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM scheduled_sessions matched
               WHERE matched.matched_transaction_id = actual.id
            )
       ) candidates ON true
      WHERE session.status IN ('pending', 'completed')
        AND session.archived_at IS NULL
        AND session.matched_transaction_id IS NULL
        AND session.session_date <= $1::date
        AND ($2::uuid[] IS NULL OR session.employee_id IS NULL OR session.employee_id = ANY($2::uuid[]))
        AND ($3::uuid[] IS NULL OR (
          EXISTS (
            SELECT 1 FROM scheduled_allocations visible
             WHERE visible.scheduled_session_id = session.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_allocations hidden
             WHERE hidden.scheduled_session_id = session.id
               AND hidden.individual_id <> ALL($3::uuid[])
          )
        ))
        AND ($4::uuid[] IS NULL OR EXISTS (
          SELECT 1
            FROM unnest($4::uuid[]) permitted(agency_id)
           WHERE NOT EXISTS (
             SELECT 1
               FROM scheduled_allocations participant
              WHERE participant.scheduled_session_id = session.id
                AND NOT EXISTS (
                  SELECT 1 FROM agency_individuals membership
                   WHERE membership.agency_id = permitted.agency_id
                     AND membership.individual_id = participant.individual_id
                     AND membership.is_active = true
                     AND membership.effective_from <= session.session_date
                     AND (membership.effective_to IS NULL OR membership.effective_to >= session.session_date)
                )
           )
             AND (session.employee_id IS NULL OR EXISTS (
               SELECT 1 FROM agency_employees membership
                WHERE membership.agency_id = permitted.agency_id
                  AND membership.employee_id = session.employee_id
                  AND membership.is_active = true
                  AND membership.effective_from <= session.session_date
                  AND (membership.effective_to IS NULL OR membership.effective_to >= session.session_date)
             ))
        ))
      ORDER BY session.session_date DESC, employee.display_name NULLS LAST, session.id
      LIMIT $5`,
    [asOf, employeeIds, individualIds, scopedAgencyIds, Math.min(Math.max(limit, 1), 500)],
  );

  const reviewRows = rows.map<PlanningMatchReviewRow>((row) => {
    const candidateCount = Number(row.candidate_count ?? 0);
    const hasPayPeriodCandidates = Number(row.pay_period_candidate_count ?? 0) > 0;
    return {
      id: row.id,
      sessionDate: row.session_date,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      programId: row.program_id,
      programCode: row.program_code,
      programName: row.program_name,
      individualIds: row.individual_ids ?? [],
      individualNames: row.individual_names ?? [],
      plannedHours: toHours(row.duration_hours),
      isGroup: row.is_group,
      groupSize: row.group_size,
      candidateCount,
      candidateHours: toHours(row.candidate_hours ?? 0),
      hasPayPeriodCandidates,
      reason: row.is_group
        ? "group"
        : candidateCount === 0
          ? "none"
          : candidateCount > 1
            ? "multiple"
            : hasPayPeriodCandidates
              ? "pay_period"
              : "possible",
    };
  });

  return {
    rows: reviewRows,
    total: Number(rows[0]?.total_count ?? 0),
    groupCount: Number(rows[0]?.total_group_count ?? 0),
    multipleCount: Number(rows[0]?.total_multiple_count ?? 0),
    noCandidateCount: Number(rows[0]?.total_no_candidate_count ?? 0),
  };
}
