import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { resolveAccessScope, canViewIndividual } from "@/lib/auth/access";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import {
  getIndividual,
  updateIndividual,
  setIndividualStatus,
  type IndividualInput,
  type IndividualStatus,
} from "@/lib/manage/individuals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read a single individual. Any signed-in role may read. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  const { id } = await params;
  try {
    const pool = getPool();
    const scope = await resolveAccessScope(pool, user);
    if (!canViewIndividual(scope, id)) return jsonError("Not found", 404);
    const record = await getIndividual(pool, id);
    if (!record) return jsonError("Not found", 404);
    return NextResponse.json({ ok: true, data: record });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/**
 * Update an individual, or move it through its lifecycle. A `body.action` of
 * archive / discharge / deactivate / restore changes status; anything else is
 * treated as a field edit. Manager or admin only.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;
  const action = body.action;

  try {
    const pool = getPool();
    if (action === "archive" || action === "discharge" || action === "deactivate" || action === "restore") {
      const status: IndividualStatus =
        action === "restore"
          ? "active"
          : action === "archive"
            ? "archived"
            : action === "discharge"
              ? "discharged"
              : "inactive";
      const result = await setIndividualStatus(pool, id, status, user.id, reason);
      return resultResponse(result, 200);
    }
    const result = await updateIndividual(pool, id, body as unknown as IndividualInput, user.id, reason);
    return resultResponse(result, 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
