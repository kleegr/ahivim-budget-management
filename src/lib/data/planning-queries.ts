import type { PgLikePool } from "@/lib/import/commit";
import { calculatePlanningCoverage, type PlanningCoverageStatus } from "@/lib/business/planning";
import { toHours } from "@/lib/money";

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
  nextScheduledDate: string | null;
}

export type PlanningSeriesIssue =
  | "unassigned"
  | "assignment_gap"
  | "authorization_gap"
  | "no_future_occurrences"
  | "session_warning";

export interface PlanningSeriesRow {
  id: string;
  employeeId: string | null;
  employeeName: string | null;
  programId: string | null;
  programName: string;
  frequency: string;
  interval: number;
  weekdays: number[];
  startDate: string;
  endDate: string;
  durationHours: string;
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
  employeeNames: string[];
  gap: "no_assignment" | "starts_uncovered" | "ends_uncovered" | "boundary_gaps";
}

export interface PlanningAssignmentRow {
  id: string;
  employeeId: string;
  employeeName: string;
  individualId: string;
  individualName: string;
  programName: string | null;
  startDate: string | null;
  endDate: string | null;
  allowedHours: string | null;
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
  summary: {
    unassignedSessions: number;
    conflictedSessions: number;
    overBudgetSessions: number;
    coverageGaps: number;
    futurePlanGaps: number;
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

function storedWarnings(value: unknown): Array<{ code: string; message: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const warning = candidate as StoredWarning;
    if (typeof warning.code !== "string") return [];
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
): Promise<PlanningWorkspaceData> {
  const [workRes, coverageRes, seriesRes, authorizationGapRes, assignmentRes] = await Promise.all([
    pool.query<{
      id: string; session_date: string; start_time: string | null; duration_hours: string;
      employee_id: string | null; employee_name: string | null; program_id: string; program_name: string;
      individual_names: string[] | null; warnings: unknown; total_count: string;
      unassigned_count: string; conflict_count: string; over_budget_count: string;
      assignment_gap: boolean; authorization_gap: boolean; has_conflict: boolean; over_budget: boolean;
    }>(
      `WITH base AS (
         SELECT s.id, s.session_date::text AS session_date, s.start_time,
                s.duration_hours::text AS duration_hours,
                s.employee_id, e.display_name AS employee_name,
                s.program_id, p.name AS program_name, s.warnings,
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
                      FROM budget_authorizations ba
                      JOIN budget_periods bp ON bp.id = ba.budget_period_id
                      WHERE ba.individual_id = target.individual_id
                        AND ba.program_id = s.program_id
                        AND ba.status = 'active' AND bp.status = 'active'
                        AND s.session_date BETWEEN bp.start_date AND bp.end_date
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
                  JOIN budget_authorizations ba
                    ON ba.individual_id = target.individual_id
                   AND ba.program_id = s.program_id AND ba.status = 'active'
                  JOIN budget_periods bp
                    ON bp.id = ba.budget_period_id AND bp.status = 'active'
                   AND s.session_date BETWEEN bp.start_date AND bp.end_date
                  WHERE target.scheduled_session_id = s.id
                    AND (
                      COALESCE((
                        SELECT sum(actual_a.allocation_hours)
                        FROM service_allocations actual_a
                        JOIN service_sessions actual_s ON actual_s.id = actual_a.service_session_id
                        WHERE actual_a.individual_id = target.individual_id
                          AND actual_s.program_id = s.program_id
                          AND COALESCE(actual_s.period_begin, actual_s.period_end)
                              BETWEEN bp.start_date AND bp.end_date
                      ), 0)
                      + COALESCE((
                        SELECT sum(planned_a.allocation_hours)
                        FROM scheduled_allocations planned_a
                        JOIN scheduled_sessions planned_s ON planned_s.id = planned_a.scheduled_session_id
                        WHERE planned_a.individual_id = target.individual_id
                          AND planned_s.program_id = s.program_id
                          AND planned_s.status = 'pending'
                          AND planned_s.session_date BETWEEN bp.start_date AND bp.end_date
                      ), 0)
                    ) > ba.authorized_hours
                ) AS over_budget
         FROM scheduled_sessions s
         LEFT JOIN employees e ON e.id = s.employee_id
         JOIN programs p ON p.id = s.program_id
         WHERE s.status = 'pending' AND s.archived_at IS NULL
       ), attention AS (
         SELECT *
         FROM base
         WHERE employee_id IS NULL OR session_date::date < $1::date
            OR assignment_gap OR authorization_gap OR has_conflict OR over_budget
            OR COALESCE(jsonb_array_length(
                 CASE WHEN jsonb_typeof(warnings) = 'array' THEN warnings ELSE '[]'::jsonb END
               ), 0) > 0
       )
       SELECT attention.*,
              count(*) OVER()::text AS total_count,
              count(*) FILTER (WHERE employee_id IS NULL) OVER()::text AS unassigned_count,
              count(*) FILTER (
                WHERE has_conflict
                   OR COALESCE(warnings, '[]'::jsonb) @> '[{"code":"employee_double_booked"}]'::jsonb
                   OR COALESCE(warnings, '[]'::jsonb) @> '[{"code":"individual_double_booked"}]'::jsonb
                   OR COALESCE(warnings, '[]'::jsonb) @> '[{"code":"individual_two_employees_one_to_one"}]'::jsonb
              ) OVER()::text AS conflict_count,
              count(*) FILTER (
                WHERE over_budget
                   OR COALESCE(warnings, '[]'::jsonb) @> '[{"code":"over_authorized_hours"}]'::jsonb
              ) OVER()::text AS over_budget_count
       FROM attention
       ORDER BY (session_date::date < $1::date) DESC,
                (employee_id IS NULL) DESC,
                session_date::date,
                start_time NULLS LAST
       LIMIT 200`,
      [asOf],
    ),
    pool.query<{
      authorization_id: string; individual_id: string; individual_name: string;
      program_id: string; program_code: string; program_name: string; period_label: string;
      start_date: string; end_date: string; authorized_hours: string; actual_hours: string;
      scheduled_hours: string; eligible_employee_count: string; next_scheduled_date: string | null;
    }>(
      `WITH current_auth AS (
         SELECT DISTINCT ON (ba.individual_id, ba.program_id)
                ba.id AS authorization_id, ba.individual_id, ba.program_id,
                ba.authorized_hours, bp.label AS period_label,
                bp.start_date, bp.end_date
         FROM budget_authorizations ba
         JOIN budget_periods bp ON bp.id = ba.budget_period_id
         JOIN individuals i ON i.id = ba.individual_id
         JOIN programs p ON p.id = ba.program_id
         WHERE ba.status = 'active' AND bp.status = 'active'
           AND i.status = 'active' AND p.is_active = true
           AND $1::date BETWEEN bp.start_date AND bp.end_date
         ORDER BY ba.individual_id, ba.program_id, bp.start_date DESC, ba.revision DESC
       )
       SELECT ca.authorization_id, ca.individual_id, i.display_name AS individual_name,
              ca.program_id, p.code AS program_code, p.name AS program_name,
              ca.period_label, ca.start_date::text AS start_date, ca.end_date::text AS end_date,
              ca.authorized_hours::text AS authorized_hours,
              COALESCE((
                SELECT sum(actual_a.allocation_hours)
                FROM service_allocations actual_a
                JOIN service_sessions actual_s ON actual_s.id = actual_a.service_session_id
                WHERE actual_a.individual_id = ca.individual_id
                  AND actual_s.program_id = ca.program_id
                  AND COALESCE(actual_s.period_begin, actual_s.period_end)
                      BETWEEN ca.start_date AND ca.end_date
              ), 0)::text AS actual_hours,
              COALESCE((
                SELECT sum(planned_a.allocation_hours)
                FROM scheduled_allocations planned_a
                JOIN scheduled_sessions planned_s ON planned_s.id = planned_a.scheduled_session_id
                WHERE planned_a.individual_id = ca.individual_id
                  AND planned_s.program_id = ca.program_id
                  AND planned_s.status = 'pending'
                  AND planned_s.session_date BETWEEN ca.start_date AND ca.end_date
              ), 0)::text AS scheduled_hours,
              (
                SELECT count(DISTINCT a.employee_id)::text
                FROM assignments a
                JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                WHERE a.individual_id = ca.individual_id
                  AND a.status = 'active' AND a.archived_at IS NULL
                  AND (a.program_id IS NULL OR a.program_id = ca.program_id)
                  AND (a.start_date IS NULL OR a.start_date <= $1::date)
                  AND (a.end_date IS NULL OR a.end_date >= $1::date)
              ) AS eligible_employee_count,
              (
                SELECT min(planned_s.session_date)::text
                FROM scheduled_allocations planned_a
                JOIN scheduled_sessions planned_s ON planned_s.id = planned_a.scheduled_session_id
                WHERE planned_a.individual_id = ca.individual_id
                  AND planned_s.program_id = ca.program_id
                  AND planned_s.status = 'pending'
                  AND planned_s.session_date BETWEEN $1::date AND ca.end_date
              ) AS next_scheduled_date
       FROM current_auth ca
       JOIN individuals i ON i.id = ca.individual_id
       JOIN programs p ON p.id = ca.program_id
       ORDER BY i.display_name, p.name`,
      [asOf],
    ),
    pool.query<{
      id: string; employee_id: string | null; employee_name: string | null;
      program_id: string | null; program_name: string | null; frequency: string; interval: number;
      weekdays: unknown; start_date: string; end_date: string; duration_hours: string;
      participant_names: string[] | null; future_occurrence_count: string;
      next_occurrence_date: string | null; assignment_gap: boolean; authorization_gap: boolean;
      warning_count: string;
    }>(
      `SELECT series.id, series.employee_id, e.display_name AS employee_name,
              series.program_id, p.name AS program_name, series.frequency, series.interval,
              series.weekdays, series.start_date::text AS start_date,
              series.end_date::text AS end_date, series.duration_hours::text AS duration_hours,
              ARRAY(
                SELECT DISTINCT i.display_name
                FROM scheduled_sessions all_s
                JOIN scheduled_allocations all_a ON all_a.scheduled_session_id = all_s.id
                JOIN individuals i ON i.id = all_a.individual_id
                WHERE all_s.series_id = series.id
                ORDER BY i.display_name
              ) AS participant_names,
              (
                SELECT count(*)::text FROM scheduled_sessions future_s
                WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                  AND future_s.session_date >= $1::date
              ) AS future_occurrence_count,
              (
                SELECT min(future_s.session_date)::text FROM scheduled_sessions future_s
                WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                  AND future_s.session_date >= $1::date
              ) AS next_occurrence_date,
              (
                EXISTS (
                  SELECT 1 FROM scheduled_sessions future_s
                  WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                    AND future_s.session_date >= $1::date AND future_s.employee_id IS NULL
                )
                OR EXISTS (
                  SELECT 1
                  FROM scheduled_sessions future_s
                  JOIN scheduled_allocations future_a ON future_a.scheduled_session_id = future_s.id
                  WHERE future_s.series_id = series.id AND future_s.status = 'pending'
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
                FROM scheduled_sessions future_s
                JOIN scheduled_allocations future_a ON future_a.scheduled_session_id = future_s.id
                WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                  AND future_s.session_date >= $1::date
                  AND NOT EXISTS (
                    SELECT 1
                    FROM budget_authorizations ba
                    JOIN budget_periods bp ON bp.id = ba.budget_period_id
                    WHERE ba.individual_id = future_a.individual_id
                      AND ba.program_id = future_s.program_id
                      AND ba.status = 'active' AND bp.status = 'active'
                      AND future_s.session_date BETWEEN bp.start_date AND bp.end_date
                  )
              ) AS authorization_gap,
              (
                SELECT count(*)::text FROM scheduled_sessions future_s
                WHERE future_s.series_id = series.id AND future_s.status = 'pending'
                  AND future_s.session_date >= $1::date
                  AND COALESCE(jsonb_array_length(
                    CASE WHEN jsonb_typeof(future_s.warnings) = 'array'
                         THEN future_s.warnings ELSE '[]'::jsonb END
                  ), 0) > 0
              ) AS warning_count
       FROM schedule_series series
       LEFT JOIN employees e ON e.id = series.employee_id
       LEFT JOIN programs p ON p.id = series.program_id
       WHERE series.status = 'active' AND series.archived_at IS NULL
         AND series.end_date >= $1::date
       ORDER BY series.start_date, e.display_name NULLS LAST`,
      [asOf],
    ),
    pool.query<{
      authorization_id: string; individual_id: string; individual_name: string;
      program_id: string; program_name: string; period_label: string; start_date: string; end_date: string;
      employee_names: string[] | null; covers_start: boolean; covers_end: boolean;
    }>(
      `WITH active_auth AS (
         SELECT DISTINCT ON (ba.budget_period_id, ba.program_id)
                ba.id AS authorization_id, ba.individual_id, ba.program_id,
                bp.label AS period_label, bp.start_date, bp.end_date
         FROM budget_authorizations ba
         JOIN budget_periods bp ON bp.id = ba.budget_period_id
         JOIN individuals i ON i.id = ba.individual_id
         JOIN programs p ON p.id = ba.program_id
         WHERE ba.status = 'active' AND bp.status = 'active'
           AND i.status = 'active' AND p.is_active = true
           AND bp.end_date >= $1::date
         ORDER BY ba.budget_period_id, ba.program_id, ba.revision DESC
       )
       SELECT aa.authorization_id, aa.individual_id, i.display_name AS individual_name,
              aa.program_id, p.name AS program_name, aa.period_label,
              aa.start_date::text AS start_date, aa.end_date::text AS end_date,
              ARRAY(
                SELECT DISTINCT e.display_name
                FROM assignments a
                JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                WHERE a.individual_id = aa.individual_id
                  AND a.status = 'active' AND a.archived_at IS NULL
                  AND (a.program_id IS NULL OR a.program_id = aa.program_id)
                  AND (a.start_date IS NULL OR a.start_date <= aa.end_date)
                  AND (a.end_date IS NULL OR a.end_date >= aa.start_date)
                ORDER BY e.display_name
              ) AS employee_names,
              EXISTS (
                SELECT 1 FROM assignments a
                JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                WHERE a.individual_id = aa.individual_id
                  AND a.status = 'active' AND a.archived_at IS NULL
                  AND (a.program_id IS NULL OR a.program_id = aa.program_id)
                  AND (a.start_date IS NULL OR a.start_date <= aa.start_date)
                  AND (a.end_date IS NULL OR a.end_date >= aa.start_date)
              ) AS covers_start,
              EXISTS (
                SELECT 1 FROM assignments a
                JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
                WHERE a.individual_id = aa.individual_id
                  AND a.status = 'active' AND a.archived_at IS NULL
                  AND (a.program_id IS NULL OR a.program_id = aa.program_id)
                  AND (a.start_date IS NULL OR a.start_date <= aa.end_date)
                  AND (a.end_date IS NULL OR a.end_date >= aa.end_date)
              ) AS covers_end
       FROM active_auth aa
       JOIN individuals i ON i.id = aa.individual_id
       JOIN programs p ON p.id = aa.program_id
       WHERE NOT EXISTS (
               SELECT 1 FROM assignments a
               JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
               WHERE a.individual_id = aa.individual_id
                 AND a.status = 'active' AND a.archived_at IS NULL
                 AND (a.program_id IS NULL OR a.program_id = aa.program_id)
                 AND (a.start_date IS NULL OR a.start_date <= aa.start_date)
                 AND (a.end_date IS NULL OR a.end_date >= aa.start_date)
             )
          OR NOT EXISTS (
               SELECT 1 FROM assignments a
               JOIN employees e ON e.id = a.employee_id AND e.status = 'active'
               WHERE a.individual_id = aa.individual_id
                 AND a.status = 'active' AND a.archived_at IS NULL
                 AND (a.program_id IS NULL OR a.program_id = aa.program_id)
                 AND (a.start_date IS NULL OR a.start_date <= aa.end_date)
                 AND (a.end_date IS NULL OR a.end_date >= aa.end_date)
             )
       ORDER BY aa.start_date, i.display_name, p.name`,
      [asOf],
    ),
    pool.query<{
      id: string; employee_id: string; employee_name: string; individual_id: string;
      individual_name: string; program_name: string | null; start_date: string | null;
      end_date: string | null; allowed_hours: string | null;
    }>(
      `SELECT a.id, a.employee_id, e.display_name AS employee_name,
              a.individual_id, i.display_name AS individual_name,
              p.name AS program_name, a.start_date::text AS start_date,
              a.end_date::text AS end_date, a.allowed_hours::text AS allowed_hours
       FROM assignments a
       JOIN employees e ON e.id = a.employee_id
       JOIN individuals i ON i.id = a.individual_id
       LEFT JOIN programs p ON p.id = a.program_id
       WHERE a.status = 'active' AND a.archived_at IS NULL
         AND e.status = 'active' AND i.status = 'active'
         AND (a.end_date IS NULL OR a.end_date >= $1::date)
       ORDER BY (a.start_date > $1::date) DESC,
                a.start_date NULLS FIRST, i.display_name, e.display_name`,
      [asOf],
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
    if (row.assignment_gap) issueCodes.push("assignment_gap");
    if (row.authorization_gap) issueCodes.push("authorization_gap");
    if (futureOccurrenceCount === 0) issueCodes.push("no_future_occurrences");
    if (Number(row.warning_count) > 0) issueCodes.push("session_warning");
    return {
      id: row.id,
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
      durationHours: toHours(row.duration_hours),
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
    else gap = "ends_uncovered";
    return {
      authorizationId: row.authorization_id,
      individualId: row.individual_id,
      individualName: row.individual_name,
      programId: row.program_id,
      programName: row.program_name,
      periodLabel: row.period_label,
      startDate: row.start_date,
      endDate: row.end_date,
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
    programName: row.program_name,
    startDate: row.start_date,
    endDate: row.end_date,
    allowedHours: row.allowed_hours === null ? null : toHours(row.allowed_hours),
    timing: row.start_date && row.start_date > asOf
      ? "future"
      : row.end_date && row.end_date <= soonDate
        ? "ending_soon"
        : "current",
  }));

  return {
    asOf,
    workQueue,
    workQueueTotal: Number(workRes.rows[0]?.total_count ?? 0),
    coverage,
    series,
    authorizationGaps,
    assignments,
    summary: {
      unassignedSessions: Number(workRes.rows[0]?.unassigned_count ?? 0),
      conflictedSessions: Number(workRes.rows[0]?.conflict_count ?? 0),
      overBudgetSessions: Number(workRes.rows[0]?.over_budget_count ?? 0),
      coverageGaps: coverage.filter((row) => row.status === "plan_gap" || row.status === "over_committed" || row.eligibleEmployeeCount === 0).length,
      futurePlanGaps: authorizationGaps.length + series.filter((row) => row.issueCodes.length > 0).length,
    },
  };
}
