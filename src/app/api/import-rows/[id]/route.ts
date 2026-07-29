import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import {
  correctRowFields,
  resetRowCorrection,
  resolveRowMatch,
  setRowReviewStatus,
} from "@/lib/manage/import-corrections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const asStringOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Curate a single staged import row. `[id]` is the import_row id; `body.action`
 * selects the operation. Manager or admin only.
 *
 *   correct  — store a { field: value } correction patch (body.patch)
 *   reset    — clear the field corrections
 *   resolve  — set/clear a canonical match (body.individualId/employeeId/programId)
 *   status   — change the review status (body.status)
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = asString(body.reason) ?? null;

  try {
    const pool = getPool();

    if (body.action === "correct") {
      const patch = body.patch;
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        return jsonError("A patch object is required.", 400);
      }
      return resultResponse(
        await correctRowFields(pool, id, patch as Record<string, unknown>, user.id, reason),
        200,
      );
    }

    if (body.action === "reset") {
      return resultResponse(await resetRowCorrection(pool, id, user.id, reason), 200);
    }

    if (body.action === "resolve") {
      const match: { individualId?: string | null; employeeId?: string | null; programId?: string | null } = {};
      if ("individualId" in body) match.individualId = asStringOrNull(body.individualId);
      if ("employeeId" in body) match.employeeId = asStringOrNull(body.employeeId);
      if ("programId" in body) match.programId = asStringOrNull(body.programId);
      return resultResponse(await resolveRowMatch(pool, id, match, user.id, reason), 200);
    }

    if (body.action === "status") {
      const status = asString(body.status) ?? "";
      return resultResponse(await setRowReviewStatus(pool, id, status, user.id, reason), 200);
    }

    return jsonError("Unknown action", 400);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
