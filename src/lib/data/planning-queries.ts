import type { PgLikePool } from "@/lib/import/commit";
import { calculatePlanningCoverage, type PlanningCoverageStatus } from "@/lib/business/planning";
import { dec, toHours } from "@/lib/money";
import type { AccessScope } from "@/lib/auth/access";

export type PlanningReasonCode =
  | "unassigned"
  | "conflict"
  | "over_budget"
  | "assignment_gap"
  | "authorization_gap"
  | "past_due"
  | "other_warning";

export interface PlanningWorkItem {
  id: string;
  sessionDate: string;
  startTime: string | null;
  durationHours: string;
  employeeId: string | null;
  employeeName: string | null;
  programId: string;
  programName: string;
  individualIds: string[];
  individualNames: string[];
  reasonCodes: PlanningReasonCode[];
  warningMessages: string[];
}

export interface PlanningCoverageRow {
  authorizationId: string;
  individualId: string;
  individualName: string;
  programId: string;
  programCode: string;
  programName: string;
  periodLabel: string;
  startDate: string;
  endDate: string;
  authorizedHours: string;
  actualHours: string;
  scheduledHours: string;
  unplannedHours: string;
  requiredWeeklyHours: string | null;
  targetToDateHours: string;
  paceGapHours: string;
  usagePercent: string;
  committedPercent: string;
  timeElapsedPercent: string;
  status: PlanningCoverageStatus;
  eligibleEmployeeCount: number;
  eligibleEmployeeIds: string[];
  nextScheduledDate: string | null;
}

export type PlanningSeriesIssue =
  | "unassigned"
  | "conflict"
  | "over_budget"
  | "assignment_gap"
  | "authorization_gap"
  | "no_future_occurrences"
  | "session_warning";

export interface PlanningSeriesRow {
  id: string;
  supersedesSeriesId: string | null;
  successorSeriesId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  programId: string | null;
  programName: string;
  frequency: string;
  interval: number;
  weekdays: number[];
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  durationHours: string;
  serviceType: string | null;
  notes: string | null;
  participantIds: string[];
  participantNames: string[];
  futureOccurrenceCount: number;
  nextOccurrenceDate: string | null;
  issueCodes: PlanningSeriesIssue[];
}

export interface PlanningAuthorizationGap {
  authorizationId: string;
  individualId: string;
  individualName: string;
  programId: string;
  programName: string;
  periodLabel: string;
  startDate: string;
  endDate: string;
  employeeIds: string[];
  employeeNames: string[];
  gap: "no_assignment" | "starts_uncovered" | "ends_uncovered" | "boundary_gaps" | "coverage_gap";
}

export interface PlanningAssignmentRow {
  id: string;
  employeeId: string;
  employeeName: string;
  individualId: string;
  individualName: string;
  programId: string | null;
  programName: string | null;
  startDate: string | null;
  endDate: string | null;
  allowedHours: string | null;
  notes: string | null;
  timing: "current" | "future" | "ending_soon";
}

export interface PlanningWorkspaceData {
  asOf: string;
  workQueue: PlanningWorkItem[];
  workQueueTotal: number;
  coverage: PlanningCoverageRow[];
  series: PlanningSeriesRow[];
  authorizationGaps: PlanningAuthorizationGap[];
  assignments: PlanningAssignmentRow[];
  nextSevenDaySessions: Array<{ sessionDate: string; employeeId: string | null; individualIds: string[]; hours: string }>;
  summary: {
    activeSchedules: number;
    scheduledNextSevenDaysHours: string;
    unassignedSessions: number;
    conflictedSessions: number;
    overBudgetSessions: number;
    coverageGaps: number;
    futurePlanGaps: number;
  };
}

export interface PlanningReferenceData {
  individuals: Array<{ id: string; label: string }>;
  employees: Array<{ id: string; label: string }>;
  programs: Array<{
    id: string;
    code: string;
    name: string;
    isGroupCapable: boolean;
    requiredAuthType: "hours" | "dollars" | "both";
    consumptionSource: "payroll" | "invoice" | "manual" | "mixed";
  }>;
}

function planningScopeArrays(scope?: AccessScope): [string[] | null, string[] | null] {
  return [
    !scope || scope.full || scope.allIndividuals ? null : scope.individualIds,
    !scope || scope.full || scope.allEmployees ? null : scope.employeeIds,
  ];
}

/** Names and operational program fields only; no employee deals or rate schedules. */
export async function getPlanningReferenceData(
  pool: PgLikePool,
  scope?: AccessScope,
): Promise<PlanningReferenceData> {
  const [individualIds, employeeIds] = planningScopeArrays(scope);
  const [individuals, employees, programs] = await Promise.all([
    pool.query<{ id: string; label: string }>(
      `SELECT id, display_name AS label FROM individuals
        WHERE status = 'active' AND archived_at IS NULL
          AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
        ORDER BY lower(display_name), id`,
      [individualIds],
    ),
    pool.query<{ id: string; label: string }>(
      `SELECT id, display_name AS label FROM employees
        WHERE status = 'active' AND archived_at IS NULL
          AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
        ORDER BY lower(display_name), id`,
      [employeeIds],
    ),
    pool.query<{
      id: string; code: string; name: string; is_group_capable: boolean;
      required_auth_type: "hours" | "dollars" | "both";
      consumption_source: "payroll" | "invoice" | "manual" | "mixed";
    }>(
      `SELECT id, code, name, is_group_capable, required_auth_type, consumption_source
         FROM programs
        WHERE is_active = true
          AND required_auth_type <> 'dollars'
          AND consumption_source IN ('payroll', 'mixed')
        ORDER BY code`,
    ),
  ]);
  return {
    individuals: individuals.rows,
    employees: employees.rows,
    programs: programs.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      isGroupCapable: row.is_group_capable,
      requiredAuthType: row.required_auth_type,
      consumptionSource: row.consumption_source,
    })),
  };
}

interface StoredWarning {
  code?: unknown;
  message?: unknown;
}

const CONFLICT_WARNING_CODES = new Set([
  "employee_double_booked",
  "individual_double_booked",
  "individual_two_employees_one_to_one",
]);
const BUDGET_WARNING_CODES = new Set(["over_authorized_hours"]);
const ASSIGNMENT_WARNING_CODES = new Set(["not_assigned"]);
const AUTHORIZATION_WARNING_CODES = new Set(["missing_authorization", "outside_authorization_dates"]);
const LIVE_WARNING_CODES = new Set([
  ...CONFLICT_WARNING_CODES,
  ...BUDGET_WARNING_CODES,
  ...ASSIGNMENT_WARNING_CODES,
  ...AUTHORIZATION_WARNING_CODES,
]);

function storedWarnings(value: unknown): Array<{ code: string; message: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const warning = candidate as StoredWarning;
    if (typeof warning.code !== "string") return [];
    if (warning.code === "missing_rate" || LIVE_WARNING_CODES.has(warning.code)) return [];
    return [{
      code: warning.code,
      message: typeof warning.message === "string" ? warning.message : null,
    }];
  });
}

function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

/** Operational data for the four views on the Planning workspace. */
export async function getPlanningWorkspace(
  pool: PgLikePool,
  asOf: string,
  scope?: AccessScope,
  agencyIds: string[] = [],
): Promise<PlanningWorkspaceData> {
  const [individualIds, employeeIds] = planningScopeArrays(scope);
  const agencyScoped = agencyIds.length > 0;
  const params = [asOf, individualIds, employeeIds, agencyScoped, agencyScoped ? agencyIds : null];
  const [workRes, coverageRes, seriesRes, authorizationGapRes, assignmentRes, weekRes] = await Promise.all([
    pool.query<{
      id: string; session_date: string; start_time: string | null; duration_hours: string;
      employee_id: string | null; employee_name: string | null; program_id: string; program_name: string;
      individual_ids: string[] | null; individual_names: string[] | null; warnings: unknown; total_count: string;
      unassigned_count: string; conflict_count: string; over_budget_count: string;
      assignment_gap: boolean; authorization_gap: boolean; has_conflict: boolean; over_budget: boolean;
    }>(
      `WITH base AS (
         SELECT s.id, s.session_date::text AS session_date, s.start_time,
                s.duration_hours::text AS duration_hours,
                s.employee_id, e.display_name AS employee_name,
                s.program_id, p.name AS program_name, s.warnings,
                ARRAY(
                  SELECT names_a.individual_id::text
                  FROM scheduled_allocations names_a
                  WHERE names_a.scheduled_session_id = s.id
                  ORDER BY names_a.individual_id::text
                ) AS individual_ids,
                ARRAY(
                  SELECT i.display_name
                  FROM scheduled_allocations names_a
                  JOIN individuals i ON i.id = names_a.individual_id
                  WHERE names_a.scheduled_session_id = s.id
                  ORDER BY i.display_name
                ) AS individual_names,
                (
                  s.employee_id IS NOT NULL AND EXISTS (
                    SELECT 1
                    FROM scheduled_allocations target
                    WHERE target.scheduled_session_id = s.id
                      AND NOT EXISTS (
                        SELECT 1 FROM assignments a
                        WHERE a.employee_id = s.employee_id
                          AND a.individual_id = target.individual_id
                          AND a.status = 'active' AND a.archived_at IS NULL
                          AND (a.program_id IS NULL OR a.program_id = s.program_id)
                          AND (a.start_date IS NULL OR a.start_date <= s.session_date)
                          AND (a.end_date IS NULL OR a.end_date >= s.session_date)
                      )
                  )
                ) AS assignment_gap,
                EXISTS (
                  SELECT 1
                  FROM scheduled_allocations target
                  WHERE target.scheduled_session_id = s.id
                    AND NOT EXISTS (
                      SELECT 1
                      FROM effective_budget_authorizations_at(s.session_date) ea
                      WHERE ea.individual_id = target.individual_id
                        AND ea.program_id = s.program_id
                    )
                ) AS authorization_gap,
                (
                  EXISTS (
                    SELECT 1 FROM scheduled_sessions other
                    WHERE s.employee_id IS NOT NULL
                      AND other.id <> s.id AND other.employee_id = s.employee_id
                      AND other.session_date = s.session_date
                      AND other.status IN ('pending', 'completed')
                      AND (
                        s.start_time IS NULL OR s.end_time IS NULL
                        OR other.start_time IS NULL OR other.end_time IS NULL
                        OR (s.start_time < other.end_time AND other.start_time < s.end_time)
                      )
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM scheduled_allocations target
                    JOIN scheduled_allocations other_a ON other_a.individual_id = target.individual_id
                    JOIN scheduled_sessions other ON other.id = other_a.scheduled_session_id
                    WHERE target.scheduled_session_id = s.id
                      AND other.id <> s.id AND other.session_date = s.session_date
                      AND other.status IN ('pending', 'completed')
                      AND (
                        s.start_time IS NULL OR s.end_time IS NULL
                        OR other.start_time IS NULL OR other.end_time IS NULL
                        OR (s.start_time < other.end_time AND other.start_time < s.end_time)
                      )
                  )
                ) AS has_conflict,
                EXISTS (
                  SELECT 1
                  FROM scheduled_allocations target
                  JOIN LATERAL effective_budget_authorizations_at(s.session_date) ea
                    ON ea.individual_id = target.individual_id
                   AND ea.program_id = s.program_id
                  WHERE target.scheduled_session_id = s.id
                    AND (
                      effective_billed_hours(
                        target.individual_id, s.program_id,
                        ea.start_date, ea.end_date, ea.internal_rate
                      )
                      + COALESCE((
                        SELECT sum(planned_a.allocation_hours)
                        FROM scheduled_allocations planned_a
                        JOIN scheduled_sessions planned_s ON planned_s.id = planned_a.scheduled_session_id
                        WHERE planned_a.individual_id = target.individual_id
                          AND planned_s.program_id = s.program_id
                          AND planned_s.status = 'pending'
                          AND planned_s.matched_transaction_id IS NULL
                          AND planned_s.session_date BETWEEN ea.start_date AND ea.end_date
                      ), 0)
                    ) > ea.authorized_hours
                ) AS over_budget
         FROM scheduled_sessions s
         LEFT JOIN employees e ON e.id = s.employee_id
         JOIN programs p ON p.id = s.program_id
         WHERE s.status = 'pending' AND s.matched_transaction_id IS NULL
           AND s.archived_at IS NULL
           AND ($4::boolean IS NOT TRUE OR (
             p.required_auth_type <> 'dollars'
             AND p.consumption_source IN ('payroll', 'mixed')
           ))
           AND ($5::uuid[] IS NULL OR EXISTS (
             SELECT 1 FROM unnest($5::uuid[]) permitted(agency_id)
             WHERE EXISTS (
               SELECT 1 FROM scheduled_allocations participant
                WHERE participant.scheduled_session_id = s.id
             )
               AND NOT EXISTS (
                 SELECT 1 FROM scheduled_allocations participant
                  WHERE participant.scheduled_session_id = s.id
                    AND NOT EXISTS (
                      SELECT 1 FROM agency_individuals ai
                       WHERE ai.agency_id = permitted.agency_id
                         AND ai.individual_id = participant.individual_id
                         AND ai.is_active = true
                         AND ai.effective_from <= s.session_date
                         AND (ai.effective_to IS NULL OR ai.effective_to >= s.session_date)
                    )
               )
               AND (s.employee_id IS NULL OR EXISTS (
                 SELECT 1 FROM agency_employees ae
                  WHERE ae.agency_id = permitted.agency_id
                    AND ae.employee_id = s.employee_id
                    AND ae.is_active = true
                    AND ae.effective_from <= s.session_date
                    AND (ae.effective_to IS NULL OR ae.effective_to >= s.session_date)
               ))
           ))
           AND ($3::uuid[] IS NULL OR s.employee_id IS NULL OR s.employee_id = ANY($3::uuid[]))
           AND ($2::uuid[] IS NULL OR (
             EXISTS (SELECT 1 FROM scheduled_allocations visible_a WHERE visible_a.scheduled_session_id = s.id)
             AND NOT EXISTS (
               SELECT 1 FROM scheduled_allocations hidden_a
                WHERE hidden_a.scheduled_session_id = s.id
                  AND hidden_a.individual_id <> ALL($2::uuid[])
             )
           ))
       ), attention AS (
         SELECT *
         FROM base
         WHERE employee_id IS NULL OR session_date::date < $1::date
            OR assignment_gap OR authorization_gap OR has_conflict OR over_budget
            OR EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(warnings) = 'array' THEN warnings ELSE '[]'::jsonb END
                 ) stored_warning
                  WHERE stored_warning->>'code' NOT IN (
                    'missing_rate', 'employee_double_booked', 'individual_double_booked',
                    'individual_two_employees_one_to_one', 'over_authorized_hours',
                    'not_assigned', 'missing_authorization', 'outside_authorization_dates'
                  )
               )
       )
       SELECT attention.*,
              count(*) OVER()::text AS total_count,
              count(*) FILTER (WHERE employee_id IS NULL) OVER()::text AS unassigned_count,
               count(*) FILTER (WHERE has_conflict) OVER()::text AS conflict_count,
               count(*) FILTER (WHERE over_budget) OVER()::text AS over_budget_count
       FROM attention
       ORDER BY (session_date::date < $1::date) DESC,
                (employee_id IS NULL) DESC,
                session_date::date,
                start_time NULLS LAST
       LIMIT 200`,
      params,
    ),
    pool.query<{
      authorization_id: string; individual_id: string; individual_name: string;
      program_id: string; program_code: string; program_name: string; period_label: string;
      start_date: string; end_date: string; authorized_hours: string; actual_hours: string;
      scheduled_hours: string; eligible_employee_count: string; eligible_employee_ids: string[] | null;
      next_scheduled_date: string | null;
    }>(
      `WITH current_auth AS (
         SELECT ea.authorization_id, ea.individual_id, ea.program_id,
                ea.authorized_hours, ea.period_label,
                ea.start_date, ea.end_date, ea.internal_rate
         FROM effective_budget_authorizations_at($1::date) ea
         JOIN individuals i ON i.id = ea.individual_id
         JOIN programs p ON p.id = ea.program_id
         WHERE i.status = 'active' AND p.is_active = true
           AND ($2::uuid[] IS NULL OR ea.individual_id = ANY($2::uuid[]))
           AND ($4::boolean IS NOT TRUE OR (
             p.required_auth_type <> 'dollars' AND p.consumption_source IN ('payroll', 'mixed')
           ))
       )
       SELECT ca.authorization_id, ca.individual_id, i.display_name AS individual_name,
              ca.program_id, p.code AS program_code, p.name AS program_name,
              ca.period_label, ca.start_date::text AS start_date, ca.end_date::text AS end_date,
              ca.authorized_hours::text AS authorized_hours,
              effective_billed_hours(
                ca.individual_id, ca.program_id, ca.start_date, ca.end_date, ca.internal_rate
              )::text AS actual_hours,
              COALESCE((
                SELECT sum(planned_a.allocation_hours)
                FROM scheduled_allocations planned_a
                JOIN scheduled_sessions planned_s ON planned_s.id = planned_a.scheduled_session_id
                WHERE planned_a.individual_id = ca.individual_id
                  AND planned_s.program_id = ca.program_id
                  AND planned_s.status = 'pending'
                  AND planned_s.matched_transaction_id IS NULL
                  AND planned_s.session_date BETWEEN ca.start_date AND ca.end_date
                  AND ($5::uuid[] IS NULL OR planned_s.employee_id IS NULL OR EXISTS (
                    SELECT 1 FROM agency_individuals ai
                    JOIN agency_employees ae ON ae.agency_id = ai.agency_id
                    WHERE ai.agency_id = ANY($5::uuid[])
                      AND ai.individual_id = ca.individual_id
                      AND ae.employee_id = planned_s.employee_id
                      AND ai.is_active = true AND ae.is_active = true
                      AND ai.effective_from <= planned_s.session_date AND (ai.effective_to IS NULL OR ai.effective_to >= planned_s.session_date)
                      AND ae.effective_from <= planned_s.session_date AND (ae.effective_to IS NULL OR ae.effective_to >= planned_s.session_date)
                  ))
              ), 0)::text AS scheduled_hours,
              (
                SELECT count(DISTINCT a.employee_id)::text
                FROM assignments a
                JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                WHERE a.individual_id = ca.individual_id
                  AND ($3::uuid[] IS NULL OR a.employee_id = ANY($3::uuid[]))
                  AND ($5::uuid[] IS NULL OR EXISTS (
                    SELECT 1 FROM agency_individuals ai
                    JOIN agency_employees ae ON ae.agency_id = ai.agency_id
                    WHERE ai.agency_id = ANY($5::uuid[])
                      AND ai.individual_id = ca.individual_id AND ae.employee_id = a.employee_id
                      AND ai.is_active = true AND ae.is_active = true
                      AND ai.effective_from <= $1::date AND (ai.effective_to IS NULL OR ai.effective_to >= $1::date)
                      AND ae.effective_from <= $1::date AND (ae.effective_to IS NULL OR ae.effective_to >= $1::date)
                  ))
                  AND a.status = 'active' AND a.archived_at IS NULL
                  AND (a.program_id IS NULL OR a.program_id = ca.program_id)
                  AND (a.start_date IS NULL OR a.start_date <= $1::date)
                  AND (a.end_date IS NULL OR a.end_date >= $1::date)
              ) AS eligible_employee_count,
              ARRAY(
                SELECT DISTINCT a.employee_id::text
                FROM assignments a
                JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                WHERE a.individual_id = ca.individual_id
                  AND ($3::uuid[] IS NULL OR a.employee_id = ANY($3::uuid[]))
                  AND ($5::uuid[] IS NULL OR EXISTS (
                    SELECT 1 FROM agency_individuals ai
                    JOIN agency_employees ae ON ae.agency_id = ai.agency_id
                    WHERE ai.agency_id = ANY($5::uuid[])
                      AND ai.individual_id = ca.individual_id AND ae.employee_id = a.employee_id
                      AND ai.is_active = true AND ae.is_active = true
                      AND ai.effective_from <= $1::date AND (ai.effective_to IS NULL OR ai.effective_to >= $1::date)
                      AND ae.effective_from <= $1::date AND (ae.effective_to IS NULL OR ae.effective_to >= $1::date)
                  ))
                  AND a.status = 'active' AND a.archived_at IS NULL
                  AND (a.program_id IS NULL OR a.program_id = ca.program_id)
                  AND (a.start_date IS NULL OR a.start_date <= $1::date)
                  AND (a.end_date IS NULL OR a.end_date >= $1::date)
              ) AS eligible_employee_ids,
              (
                SELECT min(planned_s.session_date)::text
                FROM scheduled_allocations planned_a
                JOIN scheduled_sessions planned_s ON planned_s.id = planned_a.scheduled_session_id
                WHERE planned_a.individual_id = ca.individual_id
                  AND planned_s.program_id = ca.program_id
                  AND planned_s.status = 'pending'
                  AND planned_s.matched_transaction_id IS NULL
                  AND planned_s.session_date BETWEEN $1::date AND ca.end_date
                  AND ($5::uuid[] IS NULL OR planned_s.employee_id IS NULL OR EXISTS (
                    SELECT 1 FROM agency_individuals ai
                    JOIN agency_employees ae ON ae.agency_id = ai.agency_id
                    WHERE ai.agency_id = ANY($5::uuid[])
                      AND ai.individual_id = ca.individual_id AND ae.employee_id = planned_s.employee_id
                      AND ai.is_active = true AND ae.is_active = true
                      AND ai.effective_from <= planned_s.session_date AND (ai.effective_to IS NULL OR ai.effective_to >= planned_s.session_date)
                      AND ae.effective_from <= planned_s.session_date AND (ae.effective_to IS NULL OR ae.effective_to >= planned_s.session_date)
                  ))
              ) AS next_scheduled_date
       FROM current_auth ca
       JOIN individuals i ON i.id = ca.individual_id
       JOIN programs p ON p.id = ca.program_id
       ORDER BY i.display_name, p.name`,
      params,
    ),
    pool.query<{
      id: string; supersedes_series_id: string | null; successor_series_id: string | null;
      employee_id: string | null; employee_name: string | null;
      program_id: string | null; program_name: string | null; frequency: string; interval: number;
      weekdays: unknown; start_date: string; end_date: string; start_time: string | null;
      end_time: string | null; duration_hours: string; service_type: string | null; notes: string | null;
      participant_ids: string[] | null; participant_names: string[] | null; future_occurrence_count: string;
      next_occurrence_date: string | null; assignment_gap: boolean; authorization_gap: boolean;
      has_conflict: boolean; over_budget: boolean; warning_count: string;
    }>(
      `WITH visible_series_sessions AS (
         SELECT visible_s.*
         FROM scheduled_sessions visible_s
         WHERE $5::uuid[] IS NULL OR EXISTS (
           SELECT 1 FROM unnest($5::uuid[]) permitted(agency_id)
           WHERE EXISTS (
             SELECT 1 FROM scheduled_allocations participant
             WHERE participant.scheduled_session_id = visible_s.id
           )
             AND NOT EXISTS (
               SELECT 1 FROM scheduled_allocations participant
               WHERE participant.scheduled_session_id = visible_s.id
                 AND NOT EXISTS (
                   SELECT 1 FROM agency_individuals ai
                   WHERE ai.agency_id = permitted.agency_id
                     AND ai.individual_id = participant.individual_id
                     AND ai.is_active = true
                     AND ai.effective_from <= visible_s.session_date
                     AND (ai.effective_to IS NULL OR ai.effective_to >= visible_s.session_date)
                 )
             )
             AND (visible_s.employee_id IS NULL OR EXISTS (
               SELECT 1 FROM agency_employees ae
               WHERE ae.agency_id = permitted.agency_id
                 AND ae.employee_id = visible_s.employee_id
                 AND ae.is_active = true
                 AND ae.effective_from <= visible_s.session_date
                 AND (ae.effective_to IS NULL OR ae.effective_to >= visible_s.session_date)
             ))
         )
       )
       SELECT series.id, series.supersedes_series_id,
              (
                SELECT successor.id
                FROM schedule_series successor
                WHERE successor.supersedes_series_id = series.id
                  AND successor.archived_at IS NULL
              ) AS successor_series_id,
              series.employee_id, e.display_name AS employee_name,
              series.program_id, p.name AS program_name, series.frequency, series.interval,
              series.weekdays,
              CASE WHEN $5::uuid[] IS NULL THEN series.start_date::text ELSE (
                SELECT min(visible_s.session_date)::text FROM visible_series_sessions visible_s
                WHERE visible_s.series_id = series.id
                  AND visible_s.status = 'pending' AND visible_s.matched_transaction_id IS NULL
                  AND visible_s.session_date >= $1::date
              ) END AS start_date,
              CASE WHEN $5::uuid[] IS NULL THEN series.end_date::text ELSE (
                SELECT max(visible_s.session_date)::text FROM visible_series_sessions visible_s
                WHERE visible_s.series_id = series.id
                  AND visible_s.status = 'pending' AND visible_s.matched_transaction_id IS NULL
                  AND visible_s.session_date >= $1::date
              ) END AS end_date,
              series.start_time, series.end_time,
              series.duration_hours::text AS duration_hours, series.service_type, series.notes,
              ARRAY(
                SELECT member.individual_id::text
                FROM schedule_series_individuals member
                JOIN individuals member_individual ON member_individual.id = member.individual_id
                WHERE member.series_id = series.id
                ORDER BY member_individual.display_name, member.individual_id::text
              ) AS participant_ids,
              ARRAY(
                SELECT i.display_name
                FROM schedule_series_individuals member
                JOIN individuals i ON i.id = member.individual_id
                WHERE member.series_id = series.id
                ORDER BY i.display_name, i.id
              ) AS participant_names,
              (
                SELECT count(*)::text FROM visible_series_sessions future_s
                WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                  AND future_s.matched_transaction_id IS NULL
                  AND future_s.session_date >= $1::date
              ) AS future_occurrence_count,
              (
                SELECT min(future_s.session_date)::text FROM visible_series_sessions future_s
                WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                  AND future_s.matched_transaction_id IS NULL
                  AND future_s.session_date >= $1::date
              ) AS next_occurrence_date,
              (
                EXISTS (
                  SELECT 1 FROM visible_series_sessions future_s
                  WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                    AND future_s.matched_transaction_id IS NULL
                    AND future_s.session_date >= $1::date AND future_s.employee_id IS NULL
                )
                OR EXISTS (
                  SELECT 1
                  FROM visible_series_sessions future_s
                  JOIN scheduled_allocations future_a ON future_a.scheduled_session_id = future_s.id
                  WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                    AND future_s.matched_transaction_id IS NULL
                    AND future_s.session_date >= $1::date
                    AND NOT EXISTS (
                      SELECT 1 FROM assignments a
                      WHERE a.employee_id = future_s.employee_id
                        AND a.individual_id = future_a.individual_id
                        AND a.status = 'active' AND a.archived_at IS NULL
                        AND (a.program_id IS NULL OR a.program_id = future_s.program_id)
                        AND (a.start_date IS NULL OR a.start_date <= future_s.session_date)
                        AND (a.end_date IS NULL OR a.end_date >= future_s.session_date)
                    )
                )
              ) AS assignment_gap,
              EXISTS (
                SELECT 1
                FROM visible_series_sessions future_s
                JOIN scheduled_allocations future_a ON future_a.scheduled_session_id = future_s.id
                WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                  AND future_s.matched_transaction_id IS NULL
                  AND future_s.session_date >= $1::date
                  AND NOT EXISTS (
                    SELECT 1
                    FROM effective_budget_authorizations_at(future_s.session_date) ea
                    WHERE ea.individual_id = future_a.individual_id
                      AND ea.program_id = future_s.program_id
                  )
              ) AS authorization_gap,
              EXISTS (
                SELECT 1
                FROM visible_series_sessions future_s
                WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                  AND future_s.matched_transaction_id IS NULL
                  AND future_s.session_date >= $1::date
                  AND (
                    (
                      future_s.employee_id IS NOT NULL
                      AND EXISTS (
                        SELECT 1 FROM visible_series_sessions other
                        WHERE other.id <> future_s.id
                          AND other.employee_id = future_s.employee_id
                          AND other.session_date = future_s.session_date
                          AND other.status IN ('pending', 'completed')
                          AND (
                            future_s.start_time IS NULL OR future_s.end_time IS NULL
                            OR other.start_time IS NULL OR other.end_time IS NULL
                            OR (future_s.start_time < other.end_time AND other.start_time < future_s.end_time)
                          )
                      )
                    )
                    OR EXISTS (
                      SELECT 1
                      FROM scheduled_allocations target
                      JOIN scheduled_allocations other_a ON other_a.individual_id = target.individual_id
                      JOIN visible_series_sessions other ON other.id = other_a.scheduled_session_id
                      WHERE target.scheduled_session_id = future_s.id
                        AND other.id <> future_s.id
                        AND other.session_date = future_s.session_date
                        AND other.status IN ('pending', 'completed')
                        AND (
                          future_s.start_time IS NULL OR future_s.end_time IS NULL
                          OR other.start_time IS NULL OR other.end_time IS NULL
                          OR (future_s.start_time < other.end_time AND other.start_time < future_s.end_time)
                        )
                    )
                  )
              ) AS has_conflict,
              EXISTS (
                SELECT 1
                FROM visible_series_sessions future_s
                JOIN scheduled_allocations future_a ON future_a.scheduled_session_id = future_s.id
                JOIN LATERAL effective_budget_authorizations_at(future_s.session_date) ea
                  ON ea.individual_id = future_a.individual_id
                 AND ea.program_id = future_s.program_id
                WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                  AND future_s.matched_transaction_id IS NULL
                  AND future_s.session_date >= $1::date
                  AND (
                    effective_billed_hours(
                      future_a.individual_id, future_s.program_id,
                      ea.start_date, ea.end_date, ea.internal_rate
                    )
                    + COALESCE((
                      SELECT sum(planned_a.allocation_hours)
                      FROM scheduled_allocations planned_a
                      JOIN visible_series_sessions planned_s ON planned_s.id = planned_a.scheduled_session_id
                      WHERE planned_a.individual_id = future_a.individual_id
                        AND planned_s.program_id = future_s.program_id
                        AND planned_s.status = 'pending'
                        AND planned_s.matched_transaction_id IS NULL
                        AND planned_s.session_date BETWEEN ea.start_date AND ea.end_date
                    ), 0)
                  ) > ea.authorized_hours
              ) AS over_budget,
              (
                SELECT count(*)::text FROM visible_series_sessions future_s
                WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                  AND future_s.matched_transaction_id IS NULL
                  AND future_s.session_date >= $1::date
                  AND EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(future_s.warnings) = 'array'
                           THEN future_s.warnings ELSE '[]'::jsonb END
                    ) stored_warning
                    WHERE stored_warning->>'code' NOT IN (
                      'missing_rate', 'employee_double_booked', 'individual_double_booked',
                      'individual_two_employees_one_to_one', 'over_authorized_hours',
                      'not_assigned', 'missing_authorization', 'outside_authorization_dates'
                    )
                  )
              ) AS warning_count
       FROM schedule_series series
       LEFT JOIN employees e ON e.id = series.employee_id
       LEFT JOIN programs p ON p.id = series.program_id
        WHERE series.status = 'active' AND series.archived_at IS NULL
          AND series.end_date >= $1::date
          AND ($4::boolean IS NOT TRUE OR (
            p.required_auth_type <> 'dollars'
            AND p.consumption_source IN ('payroll', 'mixed')
          ))
          AND ($5::uuid[] IS NULL OR EXISTS (
            SELECT 1 FROM visible_series_sessions visible_s
            WHERE visible_s.series_id = series.id
              AND visible_s.status = 'pending'
              AND visible_s.matched_transaction_id IS NULL
              AND visible_s.session_date >= $1::date
          ))
          AND ($3::uuid[] IS NULL OR series.employee_id IS NULL OR series.employee_id = ANY($3::uuid[]))
          AND ($2::uuid[] IS NULL OR (
            EXISTS (SELECT 1 FROM schedule_series_individuals visible_member WHERE visible_member.series_id = series.id)
            AND NOT EXISTS (
              SELECT 1 FROM schedule_series_individuals hidden_member
               WHERE hidden_member.series_id = series.id
                 AND hidden_member.individual_id <> ALL($2::uuid[])
            )
          ))
       ORDER BY series.start_date, e.display_name NULLS LAST`,
      params,
    ),
    pool.query<{
      authorization_id: string; individual_id: string; individual_name: string;
      program_id: string; program_name: string; period_label: string; start_date: string; end_date: string;
      employee_ids: string[] | null; employee_names: string[] | null; covers_start: boolean; covers_end: boolean;
      has_coverage_gap: boolean;
    }>(
      `WITH active_auth AS (
         SELECT ea.authorization_id, ea.individual_id, ea.program_id,
                ea.period_label, ea.start_date, ea.end_date
         FROM effective_budget_authorizations_at($1::date) ea
         JOIN individuals i ON i.id = ea.individual_id
         JOIN programs p ON p.id = ea.program_id
         WHERE i.status = 'active' AND p.is_active = true
           AND ($2::uuid[] IS NULL OR ea.individual_id = ANY($2::uuid[]))
           AND ($4::boolean IS NOT TRUE OR (
             p.required_auth_type <> 'dollars' AND p.consumption_source IN ('payroll', 'mixed')
           ))
           AND ($5::uuid[] IS NULL OR EXISTS (
             SELECT 1 FROM agency_individuals ai
             WHERE ai.agency_id = ANY($5::uuid[])
               AND ai.individual_id = ea.individual_id
               AND ai.is_active = true
               AND ai.effective_from <= $1::date
               AND (ai.effective_to IS NULL OR ai.effective_to >= $1::date)
           ))
       ), scoped_assignments AS (
         SELECT a.*
         FROM assignments a
         WHERE $5::uuid[] IS NULL OR EXISTS (
           SELECT 1
           FROM agency_individuals ai
           JOIN agency_employees ae ON ae.agency_id = ai.agency_id
           WHERE ai.agency_id = ANY($5::uuid[])
             AND ai.individual_id = a.individual_id
             AND ae.employee_id = a.employee_id
             AND ai.is_active = true AND ae.is_active = true
             AND ai.effective_from <= COALESCE(a.start_date, '-infinity'::date)
             AND ae.effective_from <= COALESCE(a.start_date, '-infinity'::date)
             AND (a.end_date IS NOT NULL OR (ai.effective_to IS NULL AND ae.effective_to IS NULL))
             AND (a.end_date IS NULL OR ai.effective_to IS NULL OR ai.effective_to >= a.end_date)
             AND (a.end_date IS NULL OR ae.effective_to IS NULL OR ae.effective_to >= a.end_date)
         )
       )
       SELECT aa.authorization_id, aa.individual_id, i.display_name AS individual_name,
              aa.program_id, p.name AS program_name, aa.period_label,
              aa.start_date::text AS start_date, aa.end_date::text AS end_date,
              ARRAY(
                SELECT a.employee_id::text
                FROM scoped_assignments a
                JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                WHERE a.individual_id = aa.individual_id
                  AND ($3::uuid[] IS NULL OR a.employee_id = ANY($3::uuid[]))
                  AND a.status = 'active' AND a.archived_at IS NULL
                  AND (a.program_id IS NULL OR a.program_id = aa.program_id)
                  AND (a.start_date IS NULL OR a.start_date <= aa.end_date)
                  AND (a.end_date IS NULL OR a.end_date >= aa.start_date)
                ORDER BY e.display_name, a.employee_id::text
              ) AS employee_ids,
              ARRAY(
                SELECT e.display_name
                FROM scoped_assignments a
                JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                WHERE a.individual_id = aa.individual_id
                  AND ($3::uuid[] IS NULL OR a.employee_id = ANY($3::uuid[]))
                  AND a.status = 'active' AND a.archived_at IS NULL
                  AND (a.program_id IS NULL OR a.program_id = aa.program_id)
                  AND (a.start_date IS NULL OR a.start_date <= aa.end_date)
                  AND (a.end_date IS NULL OR a.end_date >= aa.start_date)
                ORDER BY e.display_name, a.employee_id::text
              ) AS employee_names,
              EXISTS (
                SELECT 1 FROM scoped_assignments a
                JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                WHERE a.individual_id = aa.individual_id
                  AND ($3::uuid[] IS NULL OR a.employee_id = ANY($3::uuid[]))
                  AND a.status = 'active' AND a.archived_at IS NULL
                  AND (a.program_id IS NULL OR a.program_id = aa.program_id)
                  AND (a.start_date IS NULL OR a.start_date <= aa.start_date)
                  AND (a.end_date IS NULL OR a.end_date >= aa.start_date)
              ) AS covers_start,
              EXISTS (
                SELECT 1 FROM scoped_assignments a
                JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                WHERE a.individual_id = aa.individual_id
                  AND ($3::uuid[] IS NULL OR a.employee_id = ANY($3::uuid[]))
                  AND a.status = 'active' AND a.archived_at IS NULL
                  AND (a.program_id IS NULL OR a.program_id = aa.program_id)
                  AND (a.start_date IS NULL OR a.start_date <= aa.end_date)
                  AND (a.end_date IS NULL OR a.end_date >= aa.end_date)
              ) AS covers_end,
              EXISTS (
                SELECT 1
                FROM generate_series(aa.start_date, aa.end_date, INTERVAL '1 day') coverage_day
                WHERE NOT EXISTS (
                  SELECT 1 FROM scoped_assignments a
                  JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                  WHERE a.individual_id = aa.individual_id
                    AND ($3::uuid[] IS NULL OR a.employee_id = ANY($3::uuid[]))
                    AND a.status = 'active' AND a.archived_at IS NULL
                    AND (a.program_id IS NULL OR a.program_id = aa.program_id)
                    AND (a.start_date IS NULL OR a.start_date <= coverage_day::date)
                    AND (a.end_date IS NULL OR a.end_date >= coverage_day::date)
                )
              ) AS has_coverage_gap
       FROM active_auth aa
       JOIN individuals i ON i.id = aa.individual_id
       JOIN programs p ON p.id = aa.program_id
        WHERE EXISTS (
                SELECT 1
                FROM generate_series(aa.start_date, aa.end_date, INTERVAL '1 day') coverage_day
                WHERE NOT EXISTS (
                  SELECT 1 FROM scoped_assignments a
                  JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                  WHERE a.individual_id = aa.individual_id
                    AND ($3::uuid[] IS NULL OR a.employee_id = ANY($3::uuid[]))
                    AND a.status = 'active' AND a.archived_at IS NULL
                    AND (a.program_id IS NULL OR a.program_id = aa.program_id)
                    AND (a.start_date IS NULL OR a.start_date <= coverage_day::date)
                    AND (a.end_date IS NULL OR a.end_date >= coverage_day::date)
                )
              )
       ORDER BY aa.start_date, i.display_name, p.name`,
      params,
    ),
    pool.query<{
      id: string; employee_id: string; employee_name: string; individual_id: string;
      individual_name: string; program_id: string | null; program_name: string | null;
      start_date: string | null; end_date: string | null; allowed_hours: string | null;
      notes: string | null;
    }>(
      `SELECT a.id, a.employee_id, e.display_name AS employee_name,
              a.individual_id, i.display_name AS individual_name,
              a.program_id, p.name AS program_name, a.start_date::text AS start_date,
              a.end_date::text AS end_date, a.allowed_hours::text AS allowed_hours,
              a.notes
       FROM assignments a
       JOIN employees e ON e.id = a.employee_id
       JOIN individuals i ON i.id = a.individual_id
       LEFT JOIN programs p ON p.id = a.program_id
       WHERE a.status = 'active' AND a.archived_at IS NULL
         AND e.status = 'active' AND i.status = 'active'
         AND (a.end_date IS NULL OR a.end_date >= $1::date)
         AND ($2::uuid[] IS NULL OR a.individual_id = ANY($2::uuid[]))
         AND ($3::uuid[] IS NULL OR a.employee_id = ANY($3::uuid[]))
         AND ($4::boolean IS NOT TRUE OR a.program_id IS NULL OR (
           p.required_auth_type <> 'dollars'
           AND p.consumption_source IN ('payroll', 'mixed')
         ))
         AND ($5::uuid[] IS NULL OR EXISTS (
           SELECT 1 FROM agency_individuals ai
           JOIN agency_employees ae ON ae.agency_id = ai.agency_id
           WHERE ai.agency_id = ANY($5::uuid[])
             AND ai.individual_id = a.individual_id AND ae.employee_id = a.employee_id
             AND ai.is_active = true AND ae.is_active = true
             AND ai.effective_from <= COALESCE(a.start_date, '-infinity'::date)
             AND ae.effective_from <= COALESCE(a.start_date, '-infinity'::date)
             AND (a.end_date IS NOT NULL OR (ai.effective_to IS NULL AND ae.effective_to IS NULL))
             AND (a.end_date IS NULL OR ai.effective_to IS NULL OR ai.effective_to >= a.end_date)
             AND (a.end_date IS NULL OR ae.effective_to IS NULL OR ae.effective_to >= a.end_date)
         ))
       ORDER BY (a.start_date > $1::date) DESC,
                a.start_date NULLS FIRST, i.display_name, e.display_name`,
      params,
    ),
    pool.query<{ session_date: string; employee_id: string | null; individual_ids: string[] | null; hours: string }>(
      `SELECT s.session_date::text, s.employee_id,
              array_agg(a.individual_id::text ORDER BY a.individual_id::text) AS individual_ids,
              COALESCE(sum(a.allocation_hours), 0)::text AS hours
       FROM scheduled_allocations a
       JOIN scheduled_sessions s ON s.id = a.scheduled_session_id
       JOIN programs p ON p.id = s.program_id
       WHERE s.status = 'pending' AND s.matched_transaction_id IS NULL
         AND s.archived_at IS NULL
         AND s.session_date BETWEEN $1::date AND ($1::date + INTERVAL '6 days')
         AND ($4::boolean IS NOT TRUE OR (
           p.required_auth_type <> 'dollars'
           AND p.consumption_source IN ('payroll', 'mixed')
         ))
         AND ($5::uuid[] IS NULL OR EXISTS (
           SELECT 1 FROM unnest($5::uuid[]) permitted(agency_id)
           WHERE NOT EXISTS (
             SELECT 1 FROM scheduled_allocations participant
             WHERE participant.scheduled_session_id = s.id
               AND NOT EXISTS (
                 SELECT 1 FROM agency_individuals ai
                 WHERE ai.agency_id = permitted.agency_id
                   AND ai.individual_id = participant.individual_id
                   AND ai.is_active = true
                   AND ai.effective_from <= s.session_date
                   AND (ai.effective_to IS NULL OR ai.effective_to >= s.session_date)
               )
           )
             AND (s.employee_id IS NULL OR EXISTS (
               SELECT 1 FROM agency_employees ae
               WHERE ae.agency_id = permitted.agency_id
                 AND ae.employee_id = s.employee_id
                 AND ae.is_active = true
                 AND ae.effective_from <= s.session_date
                 AND (ae.effective_to IS NULL OR ae.effective_to >= s.session_date)
             ))
         ))
         AND ($3::uuid[] IS NULL OR s.employee_id IS NULL OR s.employee_id = ANY($3::uuid[]))
         AND ($2::uuid[] IS NULL OR (
           EXISTS (SELECT 1 FROM scheduled_allocations visible_a WHERE visible_a.scheduled_session_id = s.id)
           AND NOT EXISTS (
             SELECT 1 FROM scheduled_allocations hidden_a
              WHERE hidden_a.scheduled_session_id = s.id
                AND hidden_a.individual_id <> ALL($2::uuid[])
           )
         ))
       GROUP BY s.id, s.session_date, s.employee_id`,
      params,
    ),
  ]);

  const workQueue: PlanningWorkItem[] = workRes.rows.map((row) => {
    const warnings = storedWarnings(row.warnings);
    const codes = new Set(warnings.map((warning) => warning.code));
    const reasonCodes: PlanningReasonCode[] = [];
    if (!row.employee_id) reasonCodes.push("unassigned");
    if (row.has_conflict || [...codes].some((code) => CONFLICT_WARNING_CODES.has(code))) reasonCodes.push("conflict");
    if (row.over_budget || [...codes].some((code) => BUDGET_WARNING_CODES.has(code))) reasonCodes.push("over_budget");
    if (row.assignment_gap || [...codes].some((code) => ASSIGNMENT_WARNING_CODES.has(code))) reasonCodes.push("assignment_gap");
    if (row.authorization_gap || [...codes].some((code) => AUTHORIZATION_WARNING_CODES.has(code))) reasonCodes.push("authorization_gap");
    if (row.session_date < asOf) reasonCodes.push("past_due");
    if (warnings.some((warning) =>
      !CONFLICT_WARNING_CODES.has(warning.code)
      && !BUDGET_WARNING_CODES.has(warning.code)
      && !ASSIGNMENT_WARNING_CODES.has(warning.code)
      && !AUTHORIZATION_WARNING_CODES.has(warning.code))) {
      reasonCodes.push("other_warning");
    }
    return {
      id: row.id,
      sessionDate: row.session_date,
      startTime: row.start_time,
      durationHours: toHours(row.duration_hours),
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      programId: row.program_id,
      programName: row.program_name,
      individualIds: row.individual_ids ?? [],
      individualNames: row.individual_names ?? [],
      reasonCodes,
      warningMessages: warnings.flatMap((warning) => warning.message ? [warning.message] : []),
    };
  });

  const coveragePriority: Record<PlanningCoverageStatus, number> = {
    over_committed: 0,
    plan_gap: 1,
    covered: 2,
    on_pace: 3,
  };
  const coverage: PlanningCoverageRow[] = coverageRes.rows.map((row) => {
    const metrics = calculatePlanningCoverage({
      authorizedHours: row.authorized_hours,
      actualHours: row.actual_hours,
      scheduledHours: row.scheduled_hours,
      startDate: row.start_date,
      endDate: row.end_date,
      asOf: utcDate(asOf),
    });
    return {
      authorizationId: row.authorization_id,
      individualId: row.individual_id,
      individualName: row.individual_name,
      programId: row.program_id,
      programCode: row.program_code,
      programName: row.program_name,
      periodLabel: row.period_label,
      startDate: row.start_date,
      endDate: row.end_date,
      authorizedHours: toHours(row.authorized_hours),
      actualHours: toHours(row.actual_hours),
      scheduledHours: toHours(row.scheduled_hours),
      ...metrics,
      eligibleEmployeeCount: Number(row.eligible_employee_count),
      eligibleEmployeeIds: row.eligible_employee_ids ?? [],
      nextScheduledDate: row.next_scheduled_date,
    };
  }).sort((a, b) =>
    Number(a.eligibleEmployeeCount > 0) - Number(b.eligibleEmployeeCount > 0)
    || coveragePriority[a.status] - coveragePriority[b.status]
    || a.individualName.localeCompare(b.individualName)
    || a.programName.localeCompare(b.programName));

  const series: PlanningSeriesRow[] = seriesRes.rows.map((row) => {
    const issueCodes: PlanningSeriesIssue[] = [];
    const futureOccurrenceCount = Number(row.future_occurrence_count);
    if (!row.employee_id) issueCodes.push("unassigned");
    if (row.has_conflict) issueCodes.push("conflict");
    if (row.over_budget) issueCodes.push("over_budget");
    if (row.assignment_gap) issueCodes.push("assignment_gap");
    if (row.authorization_gap) issueCodes.push("authorization_gap");
    if (futureOccurrenceCount === 0) issueCodes.push("no_future_occurrences");
    if (Number(row.warning_count) > 0) issueCodes.push("session_warning");
    return {
      id: row.id,
      supersedesSeriesId: row.supersedes_series_id,
      successorSeriesId: row.successor_series_id,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      programId: row.program_id,
      programName: row.program_name ?? "Program not set",
      frequency: row.frequency,
      interval: row.interval,
      weekdays: Array.isArray(row.weekdays)
        ? row.weekdays.filter((day): day is number => typeof day === "number")
        : [],
      startDate: row.start_date,
      endDate: row.end_date,
      startTime: row.start_time,
      endTime: row.end_time,
      durationHours: toHours(row.duration_hours),
      serviceType: row.service_type,
      notes: row.notes,
      participantIds: row.participant_ids ?? [],
      participantNames: row.participant_names ?? [],
      futureOccurrenceCount,
      nextOccurrenceDate: row.next_occurrence_date,
      issueCodes,
    };
  }).sort((a, b) => Number(b.issueCodes.length > 0) - Number(a.issueCodes.length > 0)
    || (a.nextOccurrenceDate ?? a.startDate).localeCompare(b.nextOccurrenceDate ?? b.startDate));

  const authorizationGaps: PlanningAuthorizationGap[] = authorizationGapRes.rows.map((row) => {
    const employeeNames = row.employee_names ?? [];
    let gap: PlanningAuthorizationGap["gap"];
    if (employeeNames.length === 0) gap = "no_assignment";
    else if (!row.covers_start && !row.covers_end) gap = "boundary_gaps";
    else if (!row.covers_start) gap = "starts_uncovered";
    else if (!row.covers_end) gap = "ends_uncovered";
    else gap = "coverage_gap";
    return {
      authorizationId: row.authorization_id,
      individualId: row.individual_id,
      individualName: row.individual_name,
      programId: row.program_id,
      programName: row.program_name,
      periodLabel: row.period_label,
      startDate: row.start_date,
      endDate: row.end_date,
      employeeIds: row.employee_ids ?? [],
      employeeNames,
      gap,
    };
  });

  const soon = utcDate(asOf);
  soon.setUTCDate(soon.getUTCDate() + 30);
  const soonDate = soon.toISOString().slice(0, 10);
  const assignments: PlanningAssignmentRow[] = assignmentRes.rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    individualId: row.individual_id,
    individualName: row.individual_name,
    programId: row.program_id,
    programName: row.program_name,
    startDate: row.start_date,
    endDate: row.end_date,
    allowedHours: row.allowed_hours === null ? null : toHours(row.allowed_hours),
    notes: row.notes,
    timing: row.start_date && row.start_date > asOf
      ? "future"
      : row.end_date && row.end_date <= soonDate
        ? "ending_soon"
        : "current",
  }));

  const nextSevenDaySessions = weekRes.rows.map((row) => ({
    sessionDate: row.session_date,
    employeeId: row.employee_id,
    individualIds: row.individual_ids ?? [],
    hours: toHours(row.hours),
  }));
  const scheduledNextSevenDaysHours = nextSevenDaySessions
    .reduce((sum, row) => sum.plus(row.hours), dec(0));
  return {
    asOf,
    workQueue,
    workQueueTotal: Number(workRes.rows[0]?.total_count ?? 0),
    coverage,
    series,
    authorizationGaps,
    assignments,
    nextSevenDaySessions,
    summary: {
      activeSchedules: series.length,
      scheduledNextSevenDaysHours: toHours(scheduledNextSevenDaysHours),
      unassignedSessions: Number(workRes.rows[0]?.unassigned_count ?? 0),
      conflictedSessions: Number(workRes.rows[0]?.conflict_count ?? 0),
      overBudgetSessions: Number(workRes.rows[0]?.over_budget_count ?? 0),
      coverageGaps: coverage.filter((row) => row.status === "plan_gap" || row.status === "over_committed" || row.eligibleEmployeeCount === 0).length,
      futurePlanGaps: authorizationGaps.length + series.filter((row) => row.issueCodes.length > 0).length,
    },
  };
}

export interface PlanningAgencyRoster {
  agencyId: string;
  individualIds: string[];
  employeeIds: string[];
  individualMemberships?: Array<{ subjectId: string; effectiveFrom: string; effectiveTo: string | null }>;
  employeeMemberships?: Array<{ subjectId: string; effectiveFrom: string; effectiveTo: string | null }>;
}

function rosterAllows(
  rosters: PlanningAgencyRoster[],
  individualIds: string[],
  employeeId: string | null,
  range?: { from: string | null; to: string | null },
): boolean {
  const covers = (
    memberships: PlanningAgencyRoster["individualMemberships"],
    fallbackIds: string[],
    id: string,
  ) => !memberships
    ? fallbackIds.includes(id)
    : memberships.some((membership) =>
      membership.subjectId === id
      && (range?.from === null
        ? membership.effectiveFrom === "-infinity"
        : range?.from === undefined || membership.effectiveFrom === "-infinity" || membership.effectiveFrom <= range.from)
      && (range?.to === null
        ? membership.effectiveTo === null || membership.effectiveTo === "infinity"
        : range?.to === undefined || membership.effectiveTo === null || membership.effectiveTo === "infinity" || membership.effectiveTo >= range.to));
  return rosters.some((roster) => individualIds.length > 0
    && individualIds.every((id) => covers(roster.individualMemberships, roster.individualIds, id))
    && (employeeId === null || covers(roster.employeeMemberships, roster.employeeIds, employeeId)));
}

function rosterVisibleRanges(
  rosters: PlanningAgencyRoster[],
  individualIds: string[],
  employeeId: string | null,
  range: { from: string; to: string },
): Array<{ from: string; to: string }> {
  return rosters.flatMap((roster) => {
    if (!roster.individualMemberships || !roster.employeeMemberships || individualIds.length === 0) {
      return rosterAllows([roster], individualIds, employeeId) ? [range] : [];
    }
    const membershipGroups = [
      ...individualIds.map((subjectId) => roster.individualMemberships!.filter((membership) =>
        membership.subjectId === subjectId)),
      ...(employeeId === null ? [] : [roster.employeeMemberships.filter((membership) =>
        membership.subjectId === employeeId)]),
    ];
    let intersections: Array<{ from: string; to: string }> = [range];
    for (const memberships of membershipGroups) {
      intersections = intersections.flatMap((current) => memberships.flatMap((membership) => {
        const from = membership.effectiveFrom === "-infinity" || membership.effectiveFrom < current.from
          ? current.from
          : membership.effectiveFrom;
        const membershipTo = membership.effectiveTo === null || membership.effectiveTo === "infinity"
          ? current.to
          : membership.effectiveTo;
        const to = membershipTo > current.to ? current.to : membershipTo;
        return from <= to ? [{ from, to }] : [];
      }));
      if (intersections.length === 0) break;
    }
    return intersections;
  }).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** Remove cross-agency pairings after the SQL axis filters have removed outsiders. */
export function filterPlanningWorkspaceForAgency(
  data: PlanningWorkspaceData,
  rosters: PlanningAgencyRoster[],
): PlanningWorkspaceData {
  if (rosters.length === 0) return data;
  const workQueue = data.workQueue.filter((row) =>
    rosterAllows(rosters, row.individualIds, row.employeeId, { from: row.sessionDate, to: row.sessionDate }));
  const series = data.series.flatMap((row) => {
    const visibleRanges = rosterVisibleRanges(
      rosters,
      row.participantIds,
      row.employeeId,
      { from: row.startDate, to: row.endDate },
    );
    if (visibleRanges.length === 0) return [];
    return [{
      ...row,
      startDate: visibleRanges[0]!.from,
      endDate: visibleRanges.at(-1)!.to,
    }];
  });
  const assignments = data.assignments.filter((row) =>
    rosterAllows(rosters, [row.individualId], row.employeeId, { from: row.startDate, to: row.endDate }));
  const coverage = data.coverage.filter((row) =>
    rosters.some((roster) => rosterAllows([roster], [row.individualId], null, {
      from: data.asOf,
      to: data.asOf,
    }))).map((row) => {
    const eligibleEmployeeIds = row.eligibleEmployeeIds.filter((employeeId) =>
      rosterAllows(rosters, [row.individualId], employeeId, { from: row.startDate, to: row.endDate }));
    return { ...row, eligibleEmployeeIds, eligibleEmployeeCount: eligibleEmployeeIds.length };
  });
  const authorizationGaps = data.authorizationGaps.map((row) => {
    const permitted = row.employeeIds.flatMap((employeeId, index) =>
      rosterAllows(rosters, [row.individualId], employeeId, { from: row.startDate, to: row.endDate }) ? [index] : []);
    return {
      ...row,
      employeeIds: permitted.map((index) => row.employeeIds[index]!),
      employeeNames: permitted.map((index) => row.employeeNames[index]!).filter(Boolean),
    };
  });
  const nextSevenDaySessions = data.nextSevenDaySessions.filter((row) =>
    rosterAllows(rosters, row.individualIds, row.employeeId, { from: row.sessionDate, to: row.sessionDate }));
  const scheduledNextSevenDaysHours = nextSevenDaySessions
    .reduce((sum, row) => sum.plus(row.hours), dec(0));
  return {
    ...data,
    workQueue,
    workQueueTotal: data.workQueueTotal,
    series,
    assignments,
    coverage,
    authorizationGaps,
    nextSevenDaySessions,
    summary: {
      ...data.summary,
      activeSchedules: series.length,
      scheduledNextSevenDaysHours: toHours(scheduledNextSevenDaysHours),
      unassignedSessions: data.summary.unassignedSessions,
      conflictedSessions: data.summary.conflictedSessions,
      overBudgetSessions: data.summary.overBudgetSessions,
      coverageGaps: coverage.filter((row) =>
        row.status === "plan_gap" || row.status === "over_committed" || row.eligibleEmployeeCount === 0).length,
      futurePlanGaps: authorizationGaps.length + series.filter((row) => row.issueCodes.length > 0).length,
    },
  };
}
