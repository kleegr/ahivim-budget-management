import { durationBetween, minutesOf, timesOverlap } from "@/lib/business/scheduling";
import type { PgLikePool } from "@/lib/import/commit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Queryable = Pick<PgLikePool, "query">;

export interface EmployeeAvailabilityInput {
  programId: string;
  individualIds: string[];
  sessionDate: string;
  sessionDates?: string[];
  startTime: string | null;
  endTime: string | null;
  excludeSessionId?: string | null;
  excludeSeriesId?: string | null;
  excludeSeriesFromDate?: string | null;
  /** Optional hours-only roster boundary for agency planners. */
  employeeIds?: string[] | null;
}

export interface EmployeeAvailability {
  employeeId: string;
  employeeName: string;
  assignedToAll: boolean;
  assignedOccurrenceCount: number;
  conflictCount: number;
  conflictingOccurrenceCount: number;
  withinDeclaredAvailabilityOccurrenceCount: number;
  outsideDeclaredAvailabilityOccurrenceCount: number;
  undeclaredAvailabilityOccurrenceCount: number;
  unavailableOccurrenceCount: number;
  reasonCodes: EmployeeAvailabilityReasonCode[];
  available: boolean;
}

export type EmployeeAvailabilityReasonCode =
  | "time_range_required"
  | "not_assigned"
  | "schedule_conflict"
  | "outside_declared_availability"
  | "dated_unavailability"
  | "availability_not_declared";

export interface EmployeeAvailabilityResult {
  timeRangeKnown: boolean;
  occurrenceCount: number;
  employees: EmployeeAvailability[];
}

interface EmployeeRow {
  employee_id: string;
  employee_name: string;
}

interface EmployeeAssignmentRow {
  employee_id: string;
  individual_id: string;
  start_date: string | null;
  end_date: string | null;
}

interface EmployeeConflictRow {
  employee_id: string;
  session_date: string;
  start_time: string | null;
  end_time: string | null;
}

interface WeeklyAvailabilityRow {
  employee_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
}

interface EmployeeUnavailabilityRow {
  employee_id: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
}

interface EmployeeAvailabilityFactRow {
  fact_type: "conflict" | "weekly" | "unavailable";
  employee_id: string;
  session_date: string | null;
  weekday: number | null;
  start_time: string | null;
  end_time: string | null;
  effective_from: string | null;
  effective_to: string | null;
  start_date: string | null;
  end_date: string | null;
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * Rank active employees for a draft session using assignments, declared
 * working hours, dated unavailability, and calendar conflicts only. This DTO
 * intentionally contains no rates, pay, checks, or transactions.
 */
export async function listEmployeeAvailability(
  pool: Queryable,
  input: EmployeeAvailabilityInput,
): Promise<EmployeeAvailabilityResult> {
  const individualIds = [...new Set(input.individualIds)];
  const sessionDates = [...new Set(input.sessionDates ?? [input.sessionDate])].sort();
  const timeRangeKnown = durationBetween(input.startTime, input.endTime) !== null;
  if (
    !UUID_RE.test(input.programId)
    || individualIds.length === 0
    || individualIds.some((id) => !UUID_RE.test(id))
    || sessionDates.length === 0
    || sessionDates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))
  ) {
    return { timeRangeKnown, occurrenceCount: sessionDates.length, employees: [] };
  }

  const employeeResult = await pool.query<EmployeeRow>(
    `SELECT id AS employee_id, display_name AS employee_name
       FROM employees
      WHERE status = 'active' AND archived_at IS NULL
        AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
      ORDER BY lower(display_name), id`,
    [input.employeeIds ?? null],
  );
  const employeeIds = employeeResult.rows.map((row) => row.employee_id);
  const assignmentResult = employeeIds.length > 0
    ? await pool.query<EmployeeAssignmentRow>(
      `SELECT employee_id, individual_id,
              start_date::text AS start_date, end_date::text AS end_date
         FROM assignments
        WHERE employee_id = ANY($1::uuid[])
          AND individual_id = ANY($2::uuid[])
          AND status = 'active'
          AND archived_at IS NULL
          AND (program_id IS NULL OR program_id = $3::uuid)
          AND (start_date IS NULL OR start_date <= $4::date)
          AND (end_date IS NULL OR end_date >= $5::date)`,
      [employeeIds, individualIds, input.programId, sessionDates.at(-1), sessionDates[0]],
    )
    : { rows: [] as EmployeeAssignmentRow[] };

  const assignmentsByEmployee = new Map<string, EmployeeAssignmentRow[]>();
  for (const assignment of assignmentResult.rows) {
    const rows = assignmentsByEmployee.get(assignment.employee_id) ?? [];
    rows.push(assignment);
    assignmentsByEmployee.set(assignment.employee_id, rows);
  }

  const conflicts = new Map<string, number>();
  const conflictingDates = new Map<string, Set<string>>();
  const weeklyByEmployee = new Map<string, WeeklyAvailabilityRow[]>();
  const unavailableByEmployee = new Map<string, EmployeeUnavailabilityRow[]>();
  if (timeRangeKnown && employeeIds.length > 0) {
    const excludeSessionId = input.excludeSessionId && UUID_RE.test(input.excludeSessionId)
      ? input.excludeSessionId
      : null;
    const excludeSeriesId = input.excludeSeriesId && UUID_RE.test(input.excludeSeriesId)
      ? input.excludeSeriesId
      : null;
    const excludeSeriesFromDate = excludeSeriesId
      && input.excludeSeriesFromDate
      && /^\d{4}-\d{2}-\d{2}$/.test(input.excludeSeriesFromDate)
      ? input.excludeSeriesFromDate
      : sessionDates[0]!;
    // This queryable may be a checked-out transaction client during schedule
    // writes. Keep all three independent reads in one statement so pg never
    // has sibling client.query calls active while a caller may need to roll
    // back, without adding three network round trips for each recurring visit.
    const factResult = await pool.query<EmployeeAvailabilityFactRow>(
      `SELECT 'conflict'::text AS fact_type,
              employee_id, session_date::text AS session_date,
              NULL::integer AS weekday,
              start_time::text AS start_time, end_time::text AS end_time,
              NULL::text AS effective_from, NULL::text AS effective_to,
              NULL::text AS start_date, NULL::text AS end_date
         FROM scheduled_sessions
        WHERE employee_id = ANY($1::uuid[])
          AND session_date = ANY($2::date[])
          AND status IN ('pending', 'completed')
          AND archived_at IS NULL
          AND ($3::uuid IS NULL OR id <> $3::uuid)
          AND (
            $4::uuid IS NULL
            OR series_id IS DISTINCT FROM $4::uuid
            OR session_date < $5::date
            OR status <> 'pending'
          )
       UNION ALL
       SELECT 'weekly'::text AS fact_type,
              employee_id, NULL::text AS session_date, weekday,
              start_time::text AS start_time, end_time::text AS end_time,
              effective_from::text AS effective_from,
              effective_to::text AS effective_to,
              NULL::text AS start_date, NULL::text AS end_date
         FROM employee_weekly_availability
        WHERE employee_id = ANY($1::uuid[])
          AND archived_at IS NULL
          AND effective_from <= $6::date
          AND (effective_to IS NULL OR effective_to >= $7::date)
       UNION ALL
       SELECT 'unavailable'::text AS fact_type,
              employee_id, NULL::text AS session_date,
              NULL::integer AS weekday,
              start_time::text AS start_time, end_time::text AS end_time,
              NULL::text AS effective_from, NULL::text AS effective_to,
              start_date::text AS start_date, end_date::text AS end_date
         FROM employee_unavailability
        WHERE employee_id = ANY($1::uuid[])
          AND archived_at IS NULL
          AND start_date <= $6::date
          AND end_date >= $7::date`,
      [
        employeeIds,
        sessionDates,
        excludeSessionId,
        excludeSeriesId,
        excludeSeriesFromDate,
        sessionDates.at(-1),
        sessionDates[0],
      ],
    );
    const conflictRows: EmployeeConflictRow[] = [];
    const weeklyRows: WeeklyAvailabilityRow[] = [];
    const unavailableRows: EmployeeUnavailabilityRow[] = [];
    for (const row of factResult.rows) {
      if (row.fact_type === "conflict" && row.session_date !== null) {
        conflictRows.push({
          employee_id: row.employee_id,
          session_date: row.session_date,
          start_time: row.start_time,
          end_time: row.end_time,
        });
      } else if (
        row.fact_type === "weekly"
        && row.weekday !== null
        && row.start_time !== null
        && row.end_time !== null
        && row.effective_from !== null
      ) {
        weeklyRows.push({
          employee_id: row.employee_id,
          weekday: row.weekday,
          start_time: row.start_time,
          end_time: row.end_time,
          effective_from: row.effective_from,
          effective_to: row.effective_to,
        });
      } else if (
        row.fact_type === "unavailable"
        && row.start_date !== null
        && row.end_date !== null
      ) {
        unavailableRows.push({
          employee_id: row.employee_id,
          start_date: row.start_date,
          end_date: row.end_date,
          start_time: row.start_time,
          end_time: row.end_time,
        });
      }
    }
    for (const row of conflictRows) {
      if (timesOverlap(input.startTime, input.endTime, row.start_time, row.end_time)) {
        conflicts.set(row.employee_id, (conflicts.get(row.employee_id) ?? 0) + 1);
        const dates = conflictingDates.get(row.employee_id) ?? new Set<string>();
        dates.add(row.session_date);
        conflictingDates.set(row.employee_id, dates);
      }
    }
    for (const row of weeklyRows) {
      const rows = weeklyByEmployee.get(row.employee_id) ?? [];
      rows.push(row);
      weeklyByEmployee.set(row.employee_id, rows);
    }
    for (const row of unavailableRows) {
      const rows = unavailableByEmployee.get(row.employee_id) ?? [];
      rows.push(row);
      unavailableByEmployee.set(row.employee_id, rows);
    }
  }

  const employees = employeeResult.rows.map((row): EmployeeAvailability => {
    const assignments = assignmentsByEmployee.get(row.employee_id) ?? [];
    const assignedOccurrenceCount = sessionDates.filter((date) =>
      individualIds.every((individualId) => assignments.some((assignment) =>
        assignment.individual_id === individualId
        && (assignment.start_date === null || assignment.start_date <= date)
        && (assignment.end_date === null || assignment.end_date >= date)))).length;
    const assignedToAll = assignedOccurrenceCount === sessionDates.length;
    const conflictCount = conflicts.get(row.employee_id) ?? 0;
    const conflictingOccurrenceCount = conflictingDates.get(row.employee_id)?.size ?? 0;
    const weekly = weeklyByEmployee.get(row.employee_id) ?? [];
    const unavailable = unavailableByEmployee.get(row.employee_id) ?? [];
    const requestedStart = minutesOf(input.startTime);
    const requestedEnd = minutesOf(input.endTime);
    let withinDeclaredAvailabilityOccurrenceCount = 0;
    let outsideDeclaredAvailabilityOccurrenceCount = 0;
    let undeclaredAvailabilityOccurrenceCount = 0;
    let unavailableOccurrenceCount = 0;
    if (timeRangeKnown && requestedStart !== null && requestedEnd !== null) {
      for (const date of sessionDates) {
        const effectiveWindows = weekly.filter((window) =>
          window.effective_from <= date
          && (window.effective_to === null || window.effective_to >= date));
        if (effectiveWindows.length === 0) {
          undeclaredAvailabilityOccurrenceCount += 1;
        } else if (effectiveWindows.some((window) => {
          const start = minutesOf(window.start_time);
          const end = minutesOf(window.end_time);
          return window.weekday === weekdayOf(date)
            && start !== null
            && end !== null
            && start <= requestedStart
            && end >= requestedEnd;
        })) {
          withinDeclaredAvailabilityOccurrenceCount += 1;
        } else {
          outsideDeclaredAvailabilityOccurrenceCount += 1;
        }

        if (unavailable.some((window) =>
          window.start_date <= date
          && window.end_date >= date
          && timesOverlap(input.startTime, input.endTime, window.start_time, window.end_time))) {
          unavailableOccurrenceCount += 1;
        }
      }
    }
    const reasonCodes: EmployeeAvailabilityReasonCode[] = [];
    if (!timeRangeKnown) reasonCodes.push("time_range_required");
    if (!assignedToAll) reasonCodes.push("not_assigned");
    if (outsideDeclaredAvailabilityOccurrenceCount > 0) {
      reasonCodes.push("outside_declared_availability");
    }
    if (unavailableOccurrenceCount > 0) reasonCodes.push("dated_unavailability");
    if (conflictingOccurrenceCount > 0) reasonCodes.push("schedule_conflict");
    if (undeclaredAvailabilityOccurrenceCount > 0) reasonCodes.push("availability_not_declared");
    return {
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      assignedToAll,
      assignedOccurrenceCount,
      conflictCount,
      conflictingOccurrenceCount,
      withinDeclaredAvailabilityOccurrenceCount,
      outsideDeclaredAvailabilityOccurrenceCount,
      undeclaredAvailabilityOccurrenceCount,
      unavailableOccurrenceCount,
      reasonCodes,
      available: timeRangeKnown
        && assignedToAll
        && conflictingOccurrenceCount === 0
        && outsideDeclaredAvailabilityOccurrenceCount === 0
        && unavailableOccurrenceCount === 0,
    };
  });

  employees.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.available && b.available
      && a.undeclaredAvailabilityOccurrenceCount !== b.undeclaredAvailabilityOccurrenceCount) {
      return a.undeclaredAvailabilityOccurrenceCount - b.undeclaredAvailabilityOccurrenceCount;
    }
    if (a.assignedToAll !== b.assignedToAll) return a.assignedToAll ? -1 : 1;
    if (a.assignedOccurrenceCount !== b.assignedOccurrenceCount) {
      return b.assignedOccurrenceCount - a.assignedOccurrenceCount;
    }
    if (a.conflictingOccurrenceCount !== b.conflictingOccurrenceCount) {
      return a.conflictingOccurrenceCount - b.conflictingOccurrenceCount;
    }
    if (a.unavailableOccurrenceCount !== b.unavailableOccurrenceCount) {
      return a.unavailableOccurrenceCount - b.unavailableOccurrenceCount;
    }
    if (a.outsideDeclaredAvailabilityOccurrenceCount !== b.outsideDeclaredAvailabilityOccurrenceCount) {
      return a.outsideDeclaredAvailabilityOccurrenceCount - b.outsideDeclaredAvailabilityOccurrenceCount;
    }
    return a.employeeName.localeCompare(b.employeeName, undefined, { sensitivity: "base" });
  });

  return { timeRangeKnown, occurrenceCount: sessionDates.length, employees };
}
