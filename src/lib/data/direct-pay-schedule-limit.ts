import {
  directPayTargetWindow,
  type DirectPayTargetInterval,
} from "@/lib/business/direct-pay-targets";
import type { PgLikePool } from "@/lib/import/commit";
import { dec, toHours } from "@/lib/money";
import { configuredSchedulePaymentRecipientSql } from "@/lib/data/schedule-payment-routing";

type DirectPayLimitQueryable = Pick<PgLikePool, "query">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface DirectPayScheduleLimitInput {
  employeeId: string;
  occurrenceDates: string[];
  /** Original series positions when routing filters out non-Direct-Pay dates. */
  occurrenceNumbers?: Readonly<Record<string, number>>;
  durationHours: string;
  asOfDate: string;
  excludeSessionId?: string | null;
  excludeSeriesId?: string | null;
  excludeSeriesFromDate?: string | null;
}

export interface DirectPayScheduleLimitProjection {
  targetId: string;
  employeeId: string;
  employeeName: string;
  windowStart: string;
  windowEnd: string;
  targetHours: string;
  recordedHours: string;
  scheduledHours: string;
  candidateHours: string;
  candidateOccurrenceCount: number;
  projectedHours: string;
  overageHours: string;
  overLimit: boolean;
  crossingOccurrence: {
    occurrenceDate: string;
    occurrenceNumber: number;
  } | null;
}

interface TargetRow {
  id: string;
  employee_id: string;
  employee_name: string;
  interval_unit: DirectPayTargetInterval;
  interval_count: number;
  target_hours: string;
  effective_from: string;
  effective_to: string | null;
}

interface TargetWindowCandidate {
  windowKey: string;
  target: TargetRow;
  startDate: string;
  endDate: string;
  occurrences: Array<{ date: string; number: number }>;
}

/**
 * Serialize schedule writes with Direct-Pay target edits for every affected
 * employee. Sorting prevents deadlocks when a reassignment touches two people.
 */
export async function lockDirectPayTargetEmployees(
  pool: DirectPayLimitQueryable,
  employeeIds: Array<string | null | undefined>,
): Promise<void> {
  const uniqueEmployeeIds = [...new Set(employeeIds.filter((id): id is string => Boolean(id)))].sort();
  if (uniqueEmployeeIds.some((id) => !UUID.test(id))) {
    throw new TypeError("A Direct-Pay target lock requires valid employee IDs.");
  }
  for (const employeeId of uniqueEmployeeIds) {
    await pool.query(
      `SELECT pg_advisory_xact_lock(hashtext('direct-pay-target:' || $1::text))`,
      [employeeId],
    );
  }
}

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Project proposed employee time into every applicable Direct-Pay target
 * window. Candidate dates must already have been classified as employee-routed
 * by the shared scheduling payment resolver.
 */
export async function projectDirectPayScheduleLimits(
  pool: DirectPayLimitQueryable,
  input: DirectPayScheduleLimitInput,
): Promise<DirectPayScheduleLimitProjection[]> {
  const occurrenceDates = [...new Set(input.occurrenceDates)].sort();
  let durationHours: string;
  try {
    const duration = dec(input.durationHours);
    if (!duration.isFinite() || duration.lte(0)) throw new Error("invalid duration");
    durationHours = toHours(duration);
  } catch {
    return [];
  }
  if (
    !UUID.test(input.employeeId)
    || occurrenceDates.length === 0
    || occurrenceDates.some((date) => !validDate(date))
    || occurrenceDates.some((date) => {
      const number = input.occurrenceNumbers?.[date];
      return number !== undefined && (!Number.isInteger(number) || number < 1);
    })
    || !validDate(input.asOfDate)
    || (input.excludeSessionId && !UUID.test(input.excludeSessionId))
    || (input.excludeSeriesId && !UUID.test(input.excludeSeriesId))
    || (input.excludeSeriesFromDate && !validDate(input.excludeSeriesFromDate))
  ) {
    return [];
  }

  const { rows: targets } = await pool.query<TargetRow>(
    `SELECT target.id::text, target.employee_id::text,
            employee.display_name AS employee_name,
            target.interval_unit, target.interval_count,
            target.target_hours::text,
            target.effective_from::text,
            target.effective_to::text
       FROM employee_direct_pay_targets target
       JOIN employees employee ON employee.id = target.employee_id
      WHERE target.employee_id = $1::uuid
        AND target.status = 'active'
        AND target.archived_at IS NULL
        AND target.effective_from <= $3::date
        AND (target.effective_to IS NULL OR target.effective_to >= $2::date)
      ORDER BY target.effective_from, target.id`,
    [input.employeeId, occurrenceDates[0], occurrenceDates.at(-1)],
  );
  if (targets.length === 0) return [];

  const windowsByKey = new Map<string, TargetWindowCandidate>();
  occurrenceDates.forEach((date, index) => {
    const target = targets.find((row) =>
      row.effective_from <= date && (row.effective_to === null || row.effective_to >= date));
    if (!target) return;
    const window = directPayTargetWindow({
      intervalUnit: target.interval_unit,
      intervalCount: target.interval_count,
      effectiveFrom: target.effective_from,
      effectiveTo: target.effective_to,
    }, date);
    if (!window) return;
    const windowKey = `${target.id}:${window.startDate}:${window.endDate}`;
    const candidate = windowsByKey.get(windowKey) ?? {
      windowKey,
      target,
      startDate: window.startDate,
      endDate: window.endDate,
      occurrences: [],
    };
    candidate.occurrences.push({
      date,
      number: input.occurrenceNumbers?.[date] ?? index + 1,
    });
    windowsByKey.set(windowKey, candidate);
  });
  const windows = [...windowsByKey.values()];
  if (windows.length === 0) return [];

  const excludeSessionId = input.excludeSessionId ?? null;
  const excludeSeriesId = input.excludeSeriesId ?? null;
  const excludeSeriesFromDate = excludeSeriesId
    ? input.excludeSeriesFromDate ?? occurrenceDates[0]!
    : occurrenceDates[0]!;
  const activity = await pool.query<{
    window_key: string;
    recorded_hours: string;
    scheduled_hours: string;
  }>(
    `WITH target_windows AS (
       SELECT *
         FROM jsonb_to_recordset($1::jsonb)
            AS target_window("windowKey" text, "employeeId" uuid, "startDate" date, "endDate" date)
     )
     SELECT target_window."windowKey" AS window_key,
            COALESCE((
              SELECT sum(payroll_row.imported_hours)
                FROM payroll_transactions payroll_row
                LEFT JOIN programs program ON program.id = payroll_row.program_id
               WHERE payroll_row.employee_id = target_window."employeeId"
                 AND effective_payment_recipient(
                       payroll_row.payment_recipient,
                       program.payment_recipient
                     ) = 'employee'
                 AND canonical_service_date(
                       payroll_row.period_begin,
                       payroll_row.check_date,
                       payroll_row.period_end
                     ) BETWEEN target_window."startDate" AND target_window."endDate"
                 AND canonical_service_date(
                       payroll_row.period_begin,
                       payroll_row.check_date,
                       payroll_row.period_end
                     ) <= $2::date
            ), 0)::text AS recorded_hours,
            COALESCE((
              SELECT sum(session.duration_hours)
                FROM scheduled_sessions session
                JOIN programs program ON program.id = session.program_id
               WHERE session.employee_id = target_window."employeeId"
                 AND session.status = 'pending'
                 AND session.matched_transaction_id IS NULL
                 AND session.session_date BETWEEN target_window."startDate" AND target_window."endDate"
                 AND ($3::uuid IS NULL OR session.id <> $3::uuid)
                 AND (
                   $4::uuid IS NULL
                   OR session.series_id IS DISTINCT FROM $4::uuid
                   OR session.session_date < $5::date
                 )
                 AND ${configuredSchedulePaymentRecipientSql("program.payment_recipient")} = 'employee'
            ), 0)::text AS scheduled_hours
       FROM target_windows target_window`,
    [
      JSON.stringify(windows.map((window) => ({
        windowKey: window.windowKey,
        employeeId: input.employeeId,
        startDate: window.startDate,
        endDate: window.endDate,
      }))),
      input.asOfDate,
      excludeSessionId,
      excludeSeriesId,
      excludeSeriesFromDate,
    ],
  );
  const activityByWindow = new Map(activity.rows.map((row) => [row.window_key, row]));

  return windows.map((window) => {
    const totals = activityByWindow.get(window.windowKey);
    const target = dec(window.target.target_hours);
    const recorded = dec(totals?.recorded_hours ?? 0);
    const scheduled = dec(totals?.scheduled_hours ?? 0);
    const duration = dec(durationHours);
    const candidateHours = duration.times(window.occurrences.length);
    const beforeCandidates = recorded.plus(scheduled);
    const projected = beforeCandidates.plus(candidateHours);
    const overage = projected.minus(target);
    let crossingOccurrence: DirectPayScheduleLimitProjection["crossingOccurrence"] = null;
    for (let index = 0; index < window.occurrences.length; index += 1) {
      if (beforeCandidates.plus(duration.times(index + 1)).gt(target)) {
        const occurrence = window.occurrences[index]!;
        crossingOccurrence = {
          occurrenceDate: occurrence.date,
          occurrenceNumber: occurrence.number,
        };
        break;
      }
    }
    return {
      targetId: window.target.id,
      employeeId: window.target.employee_id,
      employeeName: window.target.employee_name,
      windowStart: window.startDate,
      windowEnd: window.endDate,
      targetHours: toHours(target),
      recordedHours: toHours(recorded),
      scheduledHours: toHours(scheduled),
      candidateHours: toHours(candidateHours),
      candidateOccurrenceCount: window.occurrences.length,
      projectedHours: toHours(projected),
      overageHours: toHours(overage.gt(0) ? overage : 0),
      overLimit: overage.gt(0),
      crossingOccurrence,
    };
  });
}
