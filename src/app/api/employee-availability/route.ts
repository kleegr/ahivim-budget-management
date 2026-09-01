import { NextRequest, NextResponse } from "next/server";
import { agencyDate } from "@/lib/business/agency-time";
import {
  apiPlanningUser,
  planningEmployeeAllowed,
} from "@/lib/auth/planning-access";
import { getPool } from "@/lib/db";
import {
  jsonError,
  readJson,
  redactError,
  resultResponse,
  sameOriginOrFail,
} from "@/lib/http";
import {
  createEmployeeUnavailabilityWindow,
  createWeeklyAvailabilityWindow,
  listEmployeeAvailabilityRules,
  type EmployeeUnavailabilityInput,
  type WeeklyAvailabilityInput,
} from "@/lib/manage/employee-availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** List finance-free availability rules visible to this planner. */
export async function GET(request: NextRequest) {
  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);

  const url = new URL(request.url);
  const employeeId = url.searchParams.get("employeeId");
  const requestedFrom = url.searchParams.get("from");
  const requestedTo = url.searchParams.get("to");
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  if (employeeId && !UUID_RE.test(employeeId)) return jsonError("Invalid employee", 400);
  if ((requestedFrom && !isDate(requestedFrom)) || (requestedTo && !isDate(requestedTo))) {
    return jsonError("Invalid date range", 400);
  }
  if (requestedFrom && requestedTo && requestedTo < requestedFrom) {
    return jsonError("The end date is before the start date", 400);
  }

  const accessFrom = requestedFrom ?? requestedTo ?? (planning.agencyIds.length > 0 ? agencyDate() : null);
  const accessTo = requestedTo ?? accessFrom;
  if (employeeId && !planningEmployeeAllowed(planning, employeeId, "read", {
    from: accessFrom,
    to: accessTo,
  })) {
    return jsonError("Not found", 404);
  }
  const employeeIds = employeeId || planning.agencyIds.length === 0
    ? null
    : [...new Set(planning.agencyRosters.flatMap((roster) => roster.employeeIds))]
      .filter((id) => planningEmployeeAllowed(planning, id, "read", {
        from: accessFrom,
        to: accessTo,
      }));

  try {
    const data = await listEmployeeAvailabilityRules(getPool(), {
      employeeId,
      employeeIds,
      from: requestedFrom,
      to: requestedTo,
      reviewFrom: agencyDate(),
      conflictAgencyIds: planning.agencyIds.length > 0 ? planning.agencyIds : null,
      includeArchived,
    });
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/** Add normal weekly hours or a dated unavailable window. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const planning = await apiPlanningUser();
  if (!planning) return jsonError("Planning access required", 403);
  if (!planning.canManageAssignments) {
    return jsonError("Employee availability management access required", 403);
  }

  const body = await readJson(request);
  const kind = body.kind;
  const reason = typeof body.reason === "string" ? body.reason : null;
  const pool = getPool();
  try {
    if (kind === "weekly") {
      const input = body as unknown as WeeklyAvailabilityInput;
      if (!planningEmployeeAllowed(planning, input.employeeId, "assignment", {
        from: input.effectiveFrom,
        to: input.effectiveTo ?? null,
      })) return jsonError("That employee or date range is outside your agency roster", 403);
      return resultResponse(
        await createWeeklyAvailabilityWindow(pool, input, planning.user.id, reason),
        201,
      );
    }
    if (kind === "unavailable") {
      const input = body as unknown as EmployeeUnavailabilityInput;
      if (!planningEmployeeAllowed(planning, input.employeeId, "assignment", {
        from: input.startDate,
        to: input.endDate,
      })) return jsonError("That employee or date range is outside your agency roster", 403);
      return resultResponse(
        await createEmployeeUnavailabilityWindow(pool, input, planning.user.id, reason),
        201,
      );
    }
    return jsonError("Choose weekly availability or unavailable time", 400);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
