import { durationBetween, timesOverlap } from "@/lib/business/scheduling";
import type { PgLikePool } from "@/lib/import/commit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
}

export interface EmployeeAvailability {
  employeeId: string;
  employeeName: string;
  assignedToAll: boolean;
  assignedOccurrenceCount: number;
  conflictCount: number;
  conflictingOccurrenceCount: number;
  available: boolean;
}

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

/**
 * Rank active employees for a draft session using assignment and calendar data
 * only. This DTO intentionally contains no rates, pay, checks, or transactions.
 */
export async function listEmployeeAvailability(
  pool: PgLikePool,
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
      ORDER BY lower(display_name), id`,
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
    const conflictRows = await pool.query<EmployeeConflictRow>(
      `SELECT employee_id, session_date::text AS session_date, start_time, end_time
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
          )`,
      [employeeIds, sessionDates, excludeSessionId, excludeSeriesId, excludeSeriesFromDate],
    );
    for (const row of conflictRows.rows) {
      if (timesOverlap(input.startTime, input.endTime, row.start_time, row.end_time)) {
        conflicts.set(row.employee_id, (conflicts.get(row.employee_id) ?? 0) + 1);
        const dates = conflictingDates.get(row.employee_id) ?? new Set<string>();
        dates.add(row.session_date);
        conflictingDates.set(row.employee_id, dates);
      }
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
    return {
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      assignedToAll,
      assignedOccurrenceCount,
      conflictCount,
      conflictingOccurrenceCount,
      available: timeRangeKnown && assignedToAll && conflictingOccurrenceCount === 0,
    };
  });

  employees.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.assignedToAll !== b.assignedToAll) return a.assignedToAll ? -1 : 1;
    if (a.assignedOccurrenceCount !== b.assignedOccurrenceCount) {
      return b.assignedOccurrenceCount - a.assignedOccurrenceCount;
    }
    if (a.conflictingOccurrenceCount !== b.conflictingOccurrenceCount) {
      return a.conflictingOccurrenceCount - b.conflictingOccurrenceCount;
    }
    return a.employeeName.localeCompare(b.employeeName, undefined, { sensitivity: "base" });
  });

  return { timeRangeKnown, occurrenceCount: sessionDates.length, employees };
}
