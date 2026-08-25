import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiPlanningUser } from "@/lib/auth/planning-access";
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
      listSessions(pool, filter),
      listSessionWarningFlags(pool, filter),
    ]);
    const warningCountById = new Map(warningFlags.map((row) => [row.id, row.warningCount]));
    const liveSessions = sessions.map((session) => ({
      ...session,
      warningCount: warningCountById.get(session.id) ?? session.warningCount,
    }));
    return NextResponse.json({ ok: true, data: { from, to, sessions: liveSessions, warningFlags } });
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

  try {
    const pool = getPool();
    const result = await createSession(pool, input, user.id, reason);
    if (result.ok) {
      result.data.warnings = result.data.warnings.filter((warning) => warning.code !== "missing_rate");
    }
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
