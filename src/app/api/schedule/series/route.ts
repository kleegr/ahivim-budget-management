import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { createSeries, type CreateSeriesInput } from "@/lib/manage/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Parse a weekdays list of 0..6 integers from either numbers or numeric strings. */
function asWeekdays(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.push(n);
  }
  return out;
}

/** Create a recurring series and expand it into sessions. Manager or admin only. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const body = await readJson(request);
  const frequency = asString(body.frequency) === "daily" ? "daily" : "weekly";
  const intervalRaw = typeof body.interval === "number" ? body.interval : Number(asString(body.interval) ?? "1");

  const input: CreateSeriesInput = {
    employeeId: asString(body.employeeId) ?? null,
    programId: asString(body.programId) ?? "",
    individualIds: asStringArray(body.individualIds),
    startTime: asString(body.startTime) ?? null,
    endTime: asString(body.endTime) ?? null,
    durationHours: asString(body.durationHours) ?? "",
    serviceType: asString(body.serviceType) ?? null,
    notes: asString(body.notes) ?? null,
    overrideReason: asString(body.overrideReason) ?? null,
    frequency,
    interval: Number.isFinite(intervalRaw) && intervalRaw >= 1 ? Math.floor(intervalRaw) : 1,
    weekdays: asWeekdays(body.weekdays),
    startDate: asString(body.startDate) ?? "",
    endDate: asString(body.endDate) ?? "",
  };
  const reason = asString(body.reason) ?? null;

  try {
    const pool = getPool();
    const result = await createSeries(pool, input, user.id, reason);
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
