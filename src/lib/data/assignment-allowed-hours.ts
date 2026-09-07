import type { PgLikePool } from "@/lib/import/commit";
import { dec, toHours } from "@/lib/money";
import {
  configuredSchedulePaymentRecipientSql,
  resolveSchedulePaymentRecipients,
} from "@/lib/data/schedule-payment-routing";

type AssignmentHoursQueryable = Pick<PgLikePool, "query">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface AssignmentAllowedHoursEvaluation {
  assignmentId: string;
  employeeId: string;
  employeeName: string;
  individualId: string;
  individualName: string;
  programId: string | null;
  programName: string | null;
  startDate: string | null;
  endDate: string | null;
  allowedHours: string | null;
  actualHours: string;
  scheduledHours: string;
  remainingHours: string | null;
  overLimit: boolean;
}

export interface AssignmentAllowedHoursFilter {
  /** Exact visible assignment rows, used by profile read models. */
  assignmentIds?: string[];
  /** Employee + people + program + date identify assignments eligible for a draft visit. */
  employeeId?: string | null;
  individualIds?: string[];
  programId?: string | null;
  onDate?: string | null;
  /** Reschedule/reassign must remove the visit being replaced from the scheduled total. */
  excludeSessionId?: string | null;
  /** Pending unmatched rows from this series are being replaced on/after this date. */
  excludeSeriesId?: string | null;
  excludeSeriesFromDate?: string | null;
}

export interface SeriesAssignmentAllowedHoursInput {
  employeeId: string | null;
  programId: string;
  individualIds: string[];
  occurrenceDates: string[];
  durationHours: string;
  excludeSessionId?: string | null;
  excludeSeriesId?: string | null;
  excludeSeriesFromDate?: string | null;
}

export interface AssignmentAllowedHoursCrossing {
  occurrenceDate: string;
  /** One-based position in the exact post-edit recurrence that save will insert. */
  occurrenceNumber: number;
  assignmentOccurrenceNumber: number;
  scheduledBeforeHours: string;
  projectedScheduledHours: string;
  projectedTotalHours: string;
  remainingHours: string;
  overByHours: string;
}

export interface SeriesAssignmentAllowedHoursProjection {
  assignment: AssignmentAllowedHoursEvaluation;
  seriesOccurrenceCount: number;
  seriesHours: string;
  remainingAfterHours: string | null;
  overLimit: boolean;
  crossingOccurrence: AssignmentAllowedHoursCrossing | null;
}

export interface SeriesAssignmentAllowedHoursResult {
  occurrenceCount: number;
  durationHours: string;
  assignments: SeriesAssignmentAllowedHoursProjection[];
}

interface EvaluationRow {
  assignment_id: string;
  employee_id: string;
  employee_name: string;
  individual_id: string;
  individual_name: string;
  program_id: string | null;
  program_name: string | null;
  start_date: string | null;
  end_date: string | null;
  allowed_hours: string | null;
  actual_hours: string | null;
  scheduled_hours: string | null;
}

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Evaluate an assignment's full allowed-hours window from canonical ledger
 * facts and the still-planned schedule. Only pending, unmatched sessions count:
 * a matched visit is already represented by actual payroll and must not be
 * counted twice. The SQL deliberately sums signed imported hours, so
 * corrections and reversals reduce actual utilization.
 *
 * Callers must provide an assignment or subject filter. That guard prevents a
 * future profile caller from accidentally loading every person's hours.
 */
export async function evaluateAssignmentAllowedHours(
  pool: AssignmentHoursQueryable,
  filter: AssignmentAllowedHoursFilter,
): Promise<AssignmentAllowedHoursEvaluation[]> {
  const assignmentIds = filter.assignmentIds === undefined
    ? null
    : [...new Set(filter.assignmentIds)];
  const individualIds = filter.individualIds === undefined
    ? null
    : [...new Set(filter.individualIds)];
  if (assignmentIds?.length === 0 || individualIds?.length === 0) return [];
  if (assignmentIds?.some((id) => !UUID.test(id))) return [];
  if (individualIds?.some((id) => !UUID.test(id))) return [];
  if (filter.employeeId && !UUID.test(filter.employeeId)) return [];
  if (filter.programId && !UUID.test(filter.programId)) return [];
  if (filter.excludeSessionId && !UUID.test(filter.excludeSessionId)) return [];
  if (filter.excludeSeriesId && !UUID.test(filter.excludeSeriesId)) return [];
  if (filter.onDate && !validDate(filter.onDate)) return [];
  if (filter.excludeSeriesFromDate && !validDate(filter.excludeSeriesFromDate)) return [];
  if (assignmentIds === null && !filter.employeeId && individualIds === null) return [];

  const { rows } = await pool.query<EvaluationRow>(
    `SELECT assignment.id::text AS assignment_id,
            assignment.employee_id::text AS employee_id,
            employee.display_name AS employee_name,
            assignment.individual_id::text AS individual_id,
            individual.display_name AS individual_name,
            assignment.program_id::text AS program_id,
            assignment_program.name AS program_name,
            assignment.start_date::text AS start_date,
            assignment.end_date::text AS end_date,
            assignment.allowed_hours::text AS allowed_hours,
            actual.actual_hours,
            scheduled.scheduled_hours
       FROM assignments assignment
       JOIN employees employee ON employee.id = assignment.employee_id
       JOIN individuals individual ON individual.id = assignment.individual_id
       LEFT JOIN programs assignment_program ON assignment_program.id = assignment.program_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(payroll_row.imported_hours), 0)::text AS actual_hours
           FROM payroll_transactions payroll_row
           LEFT JOIN programs actual_program ON actual_program.id = payroll_row.program_id
          WHERE payroll_row.employee_id = assignment.employee_id
            AND payroll_row.individual_id = assignment.individual_id
            AND (assignment.program_id IS NULL OR payroll_row.program_id = assignment.program_id)
            AND effective_payment_recipient(
                  payroll_row.payment_recipient,
                  actual_program.payment_recipient
                ) = 'excellent_staffing'
            AND canonical_service_date(
                  payroll_row.period_begin,
                  payroll_row.check_date,
                  payroll_row.period_end
                ) IS NOT NULL
            AND (assignment.start_date IS NULL OR canonical_service_date(
                  payroll_row.period_begin,
                  payroll_row.check_date,
                  payroll_row.period_end
                ) >= assignment.start_date)
            AND (assignment.end_date IS NULL OR canonical_service_date(
                  payroll_row.period_begin,
                  payroll_row.check_date,
                  payroll_row.period_end
                ) <= assignment.end_date)
       ) actual ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(allocation.allocation_hours), 0)::text AS scheduled_hours
           FROM scheduled_allocations allocation
           JOIN scheduled_sessions session ON session.id = allocation.scheduled_session_id
           LEFT JOIN programs scheduled_program ON scheduled_program.id = session.program_id
          WHERE session.employee_id = assignment.employee_id
            AND allocation.individual_id = assignment.individual_id
            AND (assignment.program_id IS NULL OR session.program_id = assignment.program_id)
            AND session.archived_at IS NULL
            AND session.status = 'pending'
            AND session.matched_transaction_id IS NULL
            AND ($6::uuid IS NULL OR session.id <> $6::uuid)
            AND (
              $7::uuid IS NULL
              OR session.series_id IS DISTINCT FROM $7::uuid
              OR ($8::date IS NOT NULL AND session.session_date < $8::date)
            )
             AND ${configuredSchedulePaymentRecipientSql("scheduled_program.payment_recipient")}
                   = 'excellent_staffing'
            AND (assignment.start_date IS NULL OR session.session_date >= assignment.start_date)
            AND (assignment.end_date IS NULL OR session.session_date <= assignment.end_date)
       ) scheduled ON true
      WHERE assignment.status = 'active'
        AND assignment.archived_at IS NULL
        AND ($1::uuid[] IS NULL OR assignment.id = ANY($1::uuid[]))
        AND ($2::uuid IS NULL OR assignment.employee_id = $2::uuid)
        AND ($3::uuid[] IS NULL OR assignment.individual_id = ANY($3::uuid[]))
        AND ($4::uuid IS NULL OR assignment.program_id IS NULL OR assignment.program_id = $4::uuid)
        AND ($5::date IS NULL OR (
          (assignment.start_date IS NULL OR assignment.start_date <= $5::date)
          AND (assignment.end_date IS NULL OR assignment.end_date >= $5::date)
        ))
      ORDER BY lower(individual.display_name), lower(employee.display_name),
               assignment.start_date NULLS FIRST, assignment.id`,
    [
      assignmentIds,
      filter.employeeId ?? null,
      individualIds,
      filter.programId ?? null,
      filter.onDate ?? null,
      filter.excludeSessionId ?? null,
      filter.excludeSeriesId ?? null,
      filter.excludeSeriesFromDate ?? null,
    ],
  );

  return rows.map((row) => {
    const allowedHours = row.allowed_hours === null ? null : toHours(row.allowed_hours);
    const actualHours = toHours(row.actual_hours ?? "0");
    const scheduledHours = toHours(row.scheduled_hours ?? "0");
    const remaining = allowedHours === null
      ? null
      : dec(allowedHours).minus(actualHours).minus(scheduledHours);
    return {
      assignmentId: row.assignment_id,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      individualId: row.individual_id,
      individualName: row.individual_name,
      programId: row.program_id,
      programName: row.program_name,
      startDate: row.start_date,
      endDate: row.end_date,
      allowedHours,
      actualHours,
      scheduledHours,
      remainingHours: remaining === null ? null : toHours(remaining),
      overLimit: remaining?.isNegative() ?? false,
    };
  });
}

/** Project one additional visit using the same exact-decimal invariant. */
export function projectAssignmentAllowedHours(
  evaluation: AssignmentAllowedHoursEvaluation,
  proposedHours: string,
): AssignmentAllowedHoursEvaluation {
  const scheduledHours = toHours(dec(evaluation.scheduledHours).plus(proposedHours));
  const remaining = evaluation.allowedHours === null
    ? null
    : dec(evaluation.allowedHours).minus(evaluation.actualHours).minus(scheduledHours);
  return {
    ...evaluation,
    scheduledHours,
    remainingHours: remaining === null ? null : toHours(remaining),
    overLimit: remaining?.isNegative() ?? false,
  };
}

/**
 * Project the exact occurrence list that a recurring save will insert. The
 * running scheduled total advances one visit at a time, which identifies the
 * same first crossing occurrence that save-time `detectConflicts` will see.
 */
export async function projectSeriesAssignmentAllowedHours(
  pool: AssignmentHoursQueryable,
  input: SeriesAssignmentAllowedHoursInput,
): Promise<SeriesAssignmentAllowedHoursResult> {
  const occurrenceDates = [...new Set(input.occurrenceDates)].sort();
  const individualIds = [...new Set(input.individualIds)];
  let durationHours: string;
  try {
    const duration = dec(input.durationHours);
    if (!duration.isFinite() || duration.lte(0)) throw new Error("invalid duration");
    durationHours = toHours(duration);
  } catch {
    return { occurrenceCount: occurrenceDates.length, durationHours: "0.0000", assignments: [] };
  }
  if (
    !input.employeeId
    || !UUID.test(input.employeeId)
    || !UUID.test(input.programId)
    || individualIds.length === 0
    || individualIds.some((id) => !UUID.test(id))
    || occurrenceDates.length === 0
    || occurrenceDates.some((date) => !validDate(date))
  ) {
    return { occurrenceCount: occurrenceDates.length, durationHours, assignments: [] };
  }
  const excludeSeriesFromDate = input.excludeSeriesId
    ? input.excludeSeriesFromDate && validDate(input.excludeSeriesFromDate)
      ? input.excludeSeriesFromDate
      : occurrenceDates[0]!
    : null;
  const paymentRecipients = await resolveSchedulePaymentRecipients(pool, {
    employeeId: input.employeeId,
    programId: input.programId,
    onDates: occurrenceDates,
  });
  const agencyOccurrences = occurrenceDates.flatMap((date, index) => (
    paymentRecipients.get(date) === "excellent_staffing" ? [{ date, index }] : []
  ));
  if (agencyOccurrences.length === 0) {
    return { occurrenceCount: occurrenceDates.length, durationHours, assignments: [] };
  }
  const evaluations = await evaluateAssignmentAllowedHours(pool, {
    employeeId: input.employeeId,
    individualIds,
    programId: input.programId,
    excludeSessionId: input.excludeSessionId ?? null,
    excludeSeriesId: input.excludeSeriesId ?? null,
    excludeSeriesFromDate,
  });

  const assignments = evaluations.flatMap((assignment): SeriesAssignmentAllowedHoursProjection[] => {
    const coveringOccurrences = agencyOccurrences.flatMap((occurrence) => (
      (!assignment.startDate || assignment.startDate <= occurrence.date)
      && (!assignment.endDate || assignment.endDate >= occurrence.date)
        ? [occurrence]
        : []
    ));
    if (coveringOccurrences.length === 0) return [];

    let running = assignment;
    let crossingOccurrence: AssignmentAllowedHoursCrossing | null = null;
    for (let index = 0; index < coveringOccurrences.length; index += 1) {
      const occurrence = coveringOccurrences[index]!;
      const scheduledBeforeHours = running.scheduledHours;
      const projected = projectAssignmentAllowedHours(running, durationHours);
      if (!crossingOccurrence && projected.overLimit && projected.remainingHours !== null) {
        crossingOccurrence = {
          occurrenceDate: occurrence.date,
          occurrenceNumber: occurrence.index + 1,
          assignmentOccurrenceNumber: index + 1,
          scheduledBeforeHours,
          projectedScheduledHours: projected.scheduledHours,
          projectedTotalHours: toHours(dec(projected.actualHours).plus(projected.scheduledHours)),
          remainingHours: projected.remainingHours,
          overByHours: toHours(dec(projected.remainingHours).abs()),
        };
      }
      running = projected;
    }
    return [{
      assignment,
      seriesOccurrenceCount: coveringOccurrences.length,
      seriesHours: toHours(dec(durationHours).times(coveringOccurrences.length)),
      remainingAfterHours: running.remainingHours,
      overLimit: running.overLimit,
      crossingOccurrence,
    }];
  });

  return { occurrenceCount: occurrenceDates.length, durationHours, assignments };
}
