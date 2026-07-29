import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { createBudgetPeriod } from "@/lib/manage/authorizations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a budget period for an individual. Manager or admin only. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    const pool = getPool();
    const result = await createBudgetPeriod(
      pool,
      {
        individualId: body.individualId as string,
        label: body.label as string,
        startDate: (body.startDate ?? null) as string | null,
        endDate: (body.endDate ?? null) as string | null,
        periodType: (body.periodType ?? null) as string | null,
        year: (body.year ?? null) as string | number | null,
        renewalDate: (body.renewalDate ?? null) as string | null,
        notes: (body.notes ?? null) as string | null,
        source: (body.source ?? null) as string | null,
      },
      user.id,
      reason,
    );
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
