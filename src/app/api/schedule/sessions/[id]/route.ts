import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  apiPlanningUser,
  isBudgetPlanningWarningCode,
  planningProgramAllowed,
  planningSubjectsAllowed,
} from "@/lib/auth/planning-access";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import {
  setSessionStatus,
  rescheduleSession,
  duplicateSession,
} from "@/lib/manage/schedule";
import { getSession } from "@/lib/data/schedule-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const SESSION_STATUSES = ["pending", "completed", "cancelled", "no_show"] as const;
type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Read one planned session for an account with Planning access. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);

  const { id } = await params;
  try {
    const pool = getPool();
    const record = await getSession(pool, id, planning.access);
    if (record && !planningSubjectsAllowed(planning, {
      individualIds: record.individualIds,
      employeeId: record.employeeId,
    }, "read", { from: record.sessionDate, to: record.sessionDate })) return jsonError("Not found", 404);
    if (!record) return jsonError("Not found", 404);
    return NextResponse.json({ ok: true, data: record });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/**
 * Mutate one session. `action` selects the operation:
 *   status     — set completed / cancelled / no_show / pending
 *   cancel     — shorthand for status = cancelled
 *   reschedule — move date and/or times (re-runs conflict detection)
 *   duplicate  — copy the session onto another date
 * Planning access is required.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);
  const { user } = planning;
  if (!planning.canManageSchedules) return jsonError("Schedule management access required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const action = asString(body.action);
  const reason = asString(body.reason) ?? null;

  try {
    const pool = getPool();
    const existing = await getSession(pool, id, planning.access);
    if (!existing || !planningSubjectsAllowed(planning, {
      individualIds: existing.individualIds,
      employeeId: existing.employeeId,
    }, "schedule", { from: existing.sessionDate, to: existing.sessionDate })) return jsonError("Not found", 404);

    if (action === "cancel") {
      return resultResponse(await setSessionStatus(pool, id, "cancelled", user.id, reason), 200);
    }

    if (action === "status") {
      const status = asString(body.status);
      if (!status || !SESSION_STATUSES.includes(status as SessionStatus)) {
        return jsonError("Provide a valid status.", 400);
      }
      if (status !== "cancelled" && !await planningProgramAllowed(pool, planning, existing.programId)) {
        return jsonError("That inactive program can only be cancelled.", 403);
      }
      return resultResponse(await setSessionStatus(pool, id, status as SessionStatus, user.id, reason), 200);
    }

    if (action === "reschedule") {
      if (!await planningProgramAllowed(pool, planning, existing.programId)) {
        return jsonError("Choose an active hours-based planning program.", 403);
      }
      const sessionDate = asString(body.sessionDate) ?? existing.sessionDate;
      if (!planningSubjectsAllowed(planning, {
        individualIds: existing.individualIds,
        employeeId: existing.employeeId,
      }, "schedule", { from: sessionDate, to: sessionDate })) {
        return jsonError("That service date is outside your agency roster.", 403);
      }
      const result = await rescheduleSession(
          pool,
          id,
          {
            sessionDate: asString(body.sessionDate),
            startTime: body.startTime === undefined ? undefined : (asString(body.startTime) ?? null),
            endTime: body.endTime === undefined ? undefined : (asString(body.endTime) ?? null),
          },
          user.id,
          reason,
          { enforceBudgetWarnings: planning.access.canSeeBudgets },
        );
      if (result.ok) {
        result.data.warnings = result.data.warnings.filter((warning) =>
          warning.code !== "missing_rate"
          && (planning.access.canSeeBudgets || !isBudgetPlanningWarningCode(warning.code)));
      }
      return resultResponse(result, 200);
    }

    if (action === "duplicate") {
      if (!await planningProgramAllowed(pool, planning, existing.programId)) {
        return jsonError("Choose an active hours-based planning program.", 403);
      }
      const toDate = asString(body.toDate) ?? asString(body.sessionDate);
      if (!toDate) return jsonError("Provide the date to duplicate onto.", 400);
      if (!planningSubjectsAllowed(planning, {
        individualIds: existing.individualIds,
        employeeId: existing.employeeId,
      }, "schedule", { from: toDate, to: toDate })) {
        return jsonError("That service date is outside your agency roster.", 403);
      }
      const result = await duplicateSession(pool, id, toDate, user.id, reason, {
        enforceBudgetWarnings: planning.access.canSeeBudgets,
      });
      if (result.ok) {
        result.data.warnings = result.data.warnings.filter((warning) =>
          warning.code !== "missing_rate"
          && (planning.access.canSeeBudgets || !isBudgetPlanningWarningCode(warning.code)));
      }
      return resultResponse(result, 201);
    }

    return jsonError("Unknown action.", 400);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
