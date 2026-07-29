import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { bulkSetStatus, bulkResolveProgram } from "@/lib/manage/import-corrections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Bulk actions over selected rows of one import batch. `[id]` is the
 * import_batch id. Manager or admin only.
 *
 *   status   — set the same review status on the selected rows
 *   program  — resolve the same program on the selected rows
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = asString(body.reason) ?? null;
  const rowIds = asStringArray(body.rowIds);

  try {
    const pool = getPool();

    if (body.action === "status") {
      const status = asString(body.status) ?? "";
      return resultResponse(await bulkSetStatus(pool, id, rowIds, status, user.id, reason), 200);
    }

    if (body.action === "program") {
      const programId = asString(body.programId) ?? "";
      return resultResponse(await bulkResolveProgram(pool, id, rowIds, programId, user.id, reason), 200);
    }

    return jsonError("Unknown action", 400);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
