import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { applyChangedConflict, dismissConflict } from "@/lib/sheets/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Resolve a sync conflict. Manager or admin.
 *   { action: "apply" }   → pull the sheet's current value into the transaction
 *                           (refused over an audited manual correction).
 *   { action: "dismiss" } → keep the transaction as-is and close the conflict.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("You need the manager role to resolve a conflict.", 403);

  const { id } = await params;
  const body = await readJson(request);
  const action = String(body.action ?? "");

  try {
    if (action === "apply") {
      return resultResponse(await applyChangedConflict(getPool(), id, user.id));
    }
    if (action === "dismiss") {
      const note = typeof body.note === "string" ? body.note : null;
      return resultResponse(await dismissConflict(getPool(), id, user.id, note));
    }
    return jsonError('Unknown action. Use "apply" or "dismiss".', 400);
  } catch (error) {
    return jsonError(redactError(error, "The conflict could not be resolved."), 500);
  }
}
