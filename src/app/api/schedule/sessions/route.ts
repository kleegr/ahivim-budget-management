import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  apiPlanningUser,
  isBudgetPlanningWarningCode,
  planningProgramAllowed,
  planningSubjectsAllowed,
} from "@/lib/auth/planning-access";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { createSession, type CreateSessionInput } from "@/lib/manage/schedule";
import { listSessions, listSessionWarningFlags, type CalendarFilter } from "@/lib/data/schedule-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Default window: the current month, so an empty calendar request still works. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(y, m + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** List planned sessions in a date range with optional view filters. */
export async function GET(request: NextRequest) {
  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);

  const sp = request.nextUrl.searchParams;
  const range = defaultRange();
  const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = isDate(sp.get("from")) ? sp.get("from")! : range.from;
  const to = isDate(sp.get("to")) ? sp.get("to")! : range.to;

  const filter: CalendarFilter = {
    from,
    to,
    employeeId: asString(sp.get("employeeId")),
    individualId: asString(sp.get("individualId")),
    programId: asString(sp.get("programId")),
    unassigned: sp.get("unassigned") === "true",
    status: asString(sp.get("status")),
  };

  try {
    const pool = getPool();
    const [sessions, warningFlags] = await Promise.all([
      listSessions(pool, filter, planning.access),
      listSessionWarningFlags(pool, filter, planning.access),
    ]);
    const warningCountById = new Map(warningFlags.map((row) => [row.id, row.warningCount]));
    const liveSessions = sessions.filter((session) => planningSubjectsAllowed(planning, {
      individualIds: session.individualIds,
      employeeId: session.employeeId,
    }, "read", { from: session.sessionDate, to: session.sessionDate })).map((session) => ({
      ...session,
      warningCount: warningCountById.get(session.id) ?? session.warningCount,
    }));
    const visibleIds = new Set(liveSessions.map((session) => session.id));
    const visibleWarningFlags = warningFlags.filter((row) => visibleIds.has(row.id));
    return NextResponse.json({ ok: true, data: { from, to, sessions: liveSessions, warningFlags: visibleWarningFlags } });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/** Schedule a single session for an account with Planning access. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);
  const { user } = planning;

  const body = await readJson(request);
  const input: CreateSessionInput = {
    employeeId: asString(body.employeeId) ?? null,
    programId: asString(body.programId) ?? "",
    individualIds: asStringArray(body.individualIds),
    sessionDate: asString(body.sessionDate) ?? "",
    startTime: asString(body.startTime) ?? null,
    endTime: asString(body.endTime) ?? null,
    durationHours: asString(body.durationHours) ?? "",
    serviceType: asString(body.serviceType) ?? null,
    notes: asString(body.notes) ?? null,
    overrideReason: asString(body.overrideReason) ?? null,
  };
  const reason = asString(body.reason) ?? null;
  if (!planning.canManageSchedules) return jsonError("Schedule management access required", 403);
  if (!planningSubjectsAllowed(planning, {
    individualIds: input.individualIds,
    employeeId: input.employeeId,
  }, "schedule", { from: input.sessionDate, to: input.sessionDate })) return jsonError("That employee and individual are outside your agency roster for this service date.", 403);

  try {
    const pool = getPool();
    if (!await planningProgramAllowed(pool, planning, input.programId)) {
      return jsonError("Choose an active hours-based planning program.", 403);
    }
    const result = await createSession(pool, input, user.id, reason, {
      enforceBudgetWarnings: planning.access.canSeeBudgets,
    });
    if (result.ok) {
      result.data.warnings = result.data.warnings.filter((warning) =>
        warning.code !== "missing_rate"
        && (planning.access.canSeeBudgets || !isBudgetPlanningWarningCode(warning.code)));
    }
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
