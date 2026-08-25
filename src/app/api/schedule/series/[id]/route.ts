import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiPlanningUser } from "@/lib/auth/planning-access";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { cancelSeries, updateSeries, type UpdateSeriesInput } from "@/lib/manage/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];

function asWeekdays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const day = typeof item === "number" ? item : typeof item === "string" ? Number(item) : NaN;
    return Number.isInteger(day) && day >= 0 && day <= 6 ? [day] : [];
  });
}

/**
 * Mutate a recurring service schedule. Updating rebuilds pending future
 * occurrences while retaining history; cancellation keeps the legacy action.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);
  const { user } = planning;

  const { id } = await params;
  const body = await readJson(request);
  const action = asString(body.action);
  const reason = asString(body.reason) ?? null;

  try {
    const pool = getPool();
    if (action === "cancel") {
      return resultResponse(await cancelSeries(pool, id, user.id, reason), 200);
    }
    if (action === "update") {
      const frequency = asString(body.frequency);
      const status = asString(body.status);
      if (frequency !== "weekly" && frequency !== "daily") {
        return jsonError("Choose a recurrence frequency.", 400);
      }
      if (status !== "active" && status !== "cancelled") {
        return jsonError("Choose an active or cancelled status.", 400);
      }
      const intervalRaw = typeof body.interval === "number"
        ? body.interval
        : Number(asString(body.interval) ?? "1");
      const input: UpdateSeriesInput = {
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
        applyFromDate: asString(body.applyFromDate),
        status,
      };
      return resultResponse(await updateSeries(pool, id, input, user.id, reason), 200);
    }
    return jsonError("Unknown action.", 400);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
