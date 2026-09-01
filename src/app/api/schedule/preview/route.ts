import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  apiPlanningUser,
  isBudgetPlanningWarningCode,
  planningEmployeeIdsAllowedForSubjects,
  planningProgramAllowed,
  planningSeriesAllowed,
  planningSubjectsAllowed,
} from "@/lib/auth/planning-access";
import { readJson, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { previewSession, type SessionDraft } from "@/lib/manage/schedule";
import { listEmployeeAvailability } from "@/lib/data/employee-availability";
import { projectSeriesAuthorization } from "@/lib/data/series-authorization";
import { listIndividualScheduleConflicts } from "@/lib/data/individual-schedule-conflicts";
import { projectSeries } from "@/lib/business/planning-projection";
import { MAX_SERIES_OCCURRENCES } from "@/lib/business/scheduling";
import { getSession } from "@/lib/data/schedule-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const SERIES_OCCURRENCE_LIMIT_MESSAGE = `A recurring schedule can include up to ${MAX_SERIES_OCCURRENCES} visits. Shorten the date range or use a longer interval.`;
const ALL_DATE_WARNING_CODES = new Set([
  "employee_double_booked",
  "individual_double_booked",
  "individual_two_employees_one_to_one",
  "over_authorized_hours",
  "not_assigned",
  "missing_authorization",
  "outside_authorization_dates",
  "ambiguous_authorization",
]);

/**
 * Non-mutating: return operational warnings and an hours-only authorization
 * forecast for a draft session. Financial schedule data never crosses this
 * planner API boundary.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);

  const body = await readJson(request);
  const draft: SessionDraft = {
    employeeId: asString(body.employeeId) ?? null,
    programId: asString(body.programId) ?? "",
    individualIds: [...new Set(asStringArray(body.individualIds))],
    sessionDate: asString(body.sessionDate) ?? "",
    startTime: asString(body.startTime) ?? null,
    endTime: asString(body.endTime) ?? null,
    durationHours: asString(body.durationHours) ?? "",
  };
  const excludeSessionId = asString(body.excludeSessionId) ?? null;
  const recurrence = isRecord(body.recurrence) ? body.recurrence : null;
  const recurrenceFrequency = recurrence?.frequency === "daily" || recurrence?.frequency === "weekly"
    ? recurrence.frequency
    : null;
  const recurrenceInterval = typeof recurrence?.interval === "number"
    && Number.isInteger(recurrence.interval)
    && recurrence.interval >= 1
    ? recurrence.interval
    : null;
  const recurrenceWeekdays = Array.isArray(recurrence?.weekdays)
    ? [...new Set(recurrence.weekdays.filter((day): day is number =>
      typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6))]
    : [];
  const recurrenceEndDate = asString(recurrence?.endDate) ?? "";
  const requestedStartDate = asString(recurrence?.startDate) ?? draft.sessionDate;
  const requestedApplyFromDate = asString(recurrence?.applyFromDate) ?? requestedStartDate;
  const occurrenceFromDate = requestedStartDate > requestedApplyFromDate
    ? requestedStartDate
    : requestedApplyFromDate;

  if (
    !isUuid(draft.programId)
    || draft.individualIds.length === 0
    || draft.individualIds.some((id) => !isUuid(id))
    || !/^\d{4}-\d{2}-\d{2}$/.test(draft.sessionDate)
  ) {
    return NextResponse.json({
      ok: true,
      data: {
        durationHours: "0",
        warnings: [],
        forecast: [],
        employeeAvailability: { timeRangeKnown: false, occurrenceCount: 0, employees: [] },
        individualConflicts: { occurrenceCount: 0, individuals: [] },
        seriesAuthorization: null,
        validationMessage: null,
      },
    });
  }
  try {
    const pool = getPool();
    if (!await planningProgramAllowed(pool, planning, draft.programId)) {
      return jsonError("Choose an active hours-based planning program.", 403);
    }
    const editSeriesIdCandidate = asString(body.editSeriesId) ?? null;
    const editSeriesId = editSeriesIdCandidate && isUuid(editSeriesIdCandidate)
      ? editSeriesIdCandidate
      : null;
    if (excludeSessionId) {
      const excluded = isUuid(excludeSessionId)
        ? await getSession(pool, excludeSessionId, planning.access)
        : null;
      if (!excluded || !planningSubjectsAllowed(planning, {
        individualIds: excluded.individualIds,
        employeeId: excluded.employeeId,
      }, "read", { from: excluded.sessionDate, to: excluded.sessionDate })) {
        return jsonError("Not found", 404);
      }
    }
    if (editSeriesId && !await planningSeriesAllowed(pool, planning, editSeriesId)) {
      return jsonError("Not found", 404);
    }
    let recurrenceAnchorDate = requestedStartDate;

    if (recurrence && editSeriesId) {
      const current = await pool.query<{ recurrence_anchor_date: string; start_date: string }>(
        `SELECT recurrence_anchor_date::text, start_date::text
           FROM schedule_series
          WHERE id = $1 AND archived_at IS NULL`,
        [editSeriesId],
      );
      if (!current.rows[0]) return jsonError("That service schedule no longer exists.", 404);
      if (requestedStartDate === current.rows[0].start_date) {
        recurrenceAnchorDate = current.rows[0].recurrence_anchor_date;
      }
    }

    const recurrenceProjection = recurrence
      && recurrenceFrequency
      && recurrenceInterval !== null
      && /^\d{4}-\d{2}-\d{2}$/.test(recurrenceEndDate)
      && /^\d{4}-\d{2}-\d{2}$/.test(recurrenceAnchorDate)
      && /^\d{4}-\d{2}-\d{2}$/.test(occurrenceFromDate)
      ? projectSeries({
        frequency: recurrenceFrequency,
        interval: recurrenceInterval,
        weekdays: recurrenceWeekdays,
        startDate: recurrenceAnchorDate,
        fromDate: occurrenceFromDate,
        endDate: recurrenceEndDate,
        max: MAX_SERIES_OCCURRENCES + 1,
      }, draft.durationHours)
      : null;
    const validationMessage = recurrenceProjection
      && recurrenceProjection.occurrenceCount > MAX_SERIES_OCCURRENCES
      ? SERIES_OCCURRENCE_LIMIT_MESSAGE
      : null;
    let occurrenceDates = recurrence
      ? validationMessage ? [] : recurrenceProjection?.dates ?? []
      : [draft.sessionDate];

    const validOccurrenceFrom = /^\d{4}-\d{2}-\d{2}$/.test(occurrenceFromDate)
      ? occurrenceFromDate
      : draft.sessionDate;
    const validOccurrenceEnd = /^\d{4}-\d{2}-\d{2}$/.test(recurrenceEndDate)
      && recurrenceEndDate >= validOccurrenceFrom
      ? recurrenceEndDate
      : validOccurrenceFrom;
    const requestedRange = recurrence
      ? { from: validOccurrenceFrom, to: validOccurrenceEnd }
      : { from: draft.sessionDate, to: draft.sessionDate };
    const validApplyFromDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedApplyFromDate)
      ? requestedApplyFromDate
      : draft.sessionDate;
    if (editSeriesId && !await planningSeriesAllowed(pool, planning, editSeriesId, "schedule", {
      from: validApplyFromDate,
      to: requestedRange.to,
    })) {
      return jsonError("Not found", 404);
    }
    if (!planningSubjectsAllowed(planning, {
      individualIds: draft.individualIds,
      employeeId: draft.employeeId,
    }, "read", requestedRange)) return jsonError("Not found", 404);
    const candidateEmployeeIds = planningEmployeeIdsAllowedForSubjects(
      planning,
      draft.individualIds,
      requestedRange,
    );

    if (recurrence && editSeriesId && occurrenceDates.length > 0) {
      const protectedDates = await pool.query<{ session_date: string }>(
        `SELECT DISTINCT session_date::text AS session_date
           FROM scheduled_sessions
          WHERE series_id = $1
            AND session_date = ANY($2::date[])
            AND (status <> 'pending' OR matched_transaction_id IS NOT NULL)`,
        [editSeriesId, occurrenceDates],
      );
      const protectedSet = new Set(protectedDates.rows.map((row) => row.session_date));
      occurrenceDates = occurrenceDates.filter((date) => !protectedSet.has(date));
    }

    const previewDate = occurrenceDates[0] ?? requestedRange.from;
    const preview = await previewSession(pool, { ...draft, sessionDate: previewDate }, excludeSessionId);
    if (recurrence) {
      preview.warnings = preview.warnings.filter((warning) => !ALL_DATE_WARNING_CODES.has(warning.code));
    }
    const canSeeBudgets = planning.access.canSeeBudgets;
    if (!canSeeBudgets) {
      preview.warnings = preview.warnings.filter((warning) =>
        !isBudgetPlanningWarningCode(warning.code));
      preview.forecast = [];
    }
    const [employeeAvailability, individualConflicts, seriesAuthorization] = await Promise.all([
      listEmployeeAvailability(pool, {
        programId: draft.programId,
        individualIds: draft.individualIds,
        sessionDate: previewDate,
        sessionDates: occurrenceDates,
        startTime: draft.startTime,
        endTime: draft.endTime,
        excludeSessionId,
        excludeSeriesId: editSeriesId,
        excludeSeriesFromDate: validApplyFromDate,
        employeeIds: candidateEmployeeIds,
      }),
      listIndividualScheduleConflicts(pool, {
        individualIds: draft.individualIds,
        sessionDates: occurrenceDates,
        startTime: draft.startTime,
        endTime: draft.endTime,
        excludeSessionId,
        excludeSeriesId: editSeriesId,
        excludeSeriesFromDate: validApplyFromDate,
      }),
      recurrence && canSeeBudgets
        ? projectSeriesAuthorization(pool, {
          programId: draft.programId,
          individualIds: draft.individualIds,
          occurrenceDates,
          durationHours: preview.durationHours,
          excludeSessionId,
          excludeSeriesId: editSeriesId,
          excludeSeriesFromDate: validApplyFromDate,
        })
        : Promise.resolve(null),
    ]);
    return NextResponse.json({
      ok: true,
      data: {
        ...preview,
        employeeAvailability,
        individualConflicts,
        seriesAuthorization,
        validationMessage,
      },
    });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
