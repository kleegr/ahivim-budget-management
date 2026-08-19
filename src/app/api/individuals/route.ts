import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { listIndividualsManaged, createIndividual, type IndividualInput } from "@/lib/manage/individuals";
import { createStrategy, updateStrategy } from "@/lib/manage/calculation-strategies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List individuals for the management screens. Any signed-in role may read. */
export async function GET(request: NextRequest) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const includeArchived = url.searchParams.get("includeArchived") === "true";

  try {
    const pool = getPool();
    const data = await listIndividualsManaged(pool, { status, search, includeArchived });
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/** Create an individual. Manager or admin only. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    const pool = getPool();
    const result = await createIndividual(pool, body as unknown as IndividualInput, user.id, reason);
    // Seed the budget plan with the renewal date so it's tied to the person from
    // the start; programs and hours are then added on the profile.
    const renewalDate = typeof body.renewalDate === "string" ? body.renewalDate.trim() : "";
    if (result.ok && renewalDate) {
      const strat = await createStrategy(pool, { individualId: result.data.id }, user.id);
      if (strat.ok) await updateStrategy(pool, { id: strat.data.id, renewalDate }, user.id, "Set at creation");
    }
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
