import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { setUserActive, setUserRole, listUsers } from "@/lib/auth/users";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";
import { isUuid } from "@/lib/data/app-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Change a user's role or enabled state.
 *
 * Two guards that matter: an administrator cannot demote or disable their own
 * account (which would lock them out mid-session), and the last remaining
 * enabled administrator cannot be removed, which would leave the installation
 * with no way back in.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const actor = await apiUser("admin");
  if (!actor) return jsonError("Administrator role required", 403);

  const { id } = await params;
  if (!isUuid(id)) return jsonError("Not found", 404);
  if (id === actor.id) {
    return jsonError("You cannot change your own role or disable your own account.", 409);
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const pool = getPool();

  try {
    const users = await listUsers(pool);
    const target = users.find((u) => u.id === id);
    if (!target) return jsonError("Not found", 404);

    const activeAdmins = users.filter((u) => u.role === "admin" && u.isActive);
    const removingAdmin =
      target.role === "admin" &&
      ((typeof body.role === "string" && body.role !== "admin") || body.isActive === false);
    if (removingAdmin && activeAdmins.length <= 1) {
      return jsonError(
        "This is the last enabled administrator. Promote another account first.",
        409,
      );
    }

    if (typeof body.role === "string" && !(await setUserRole(pool, id, body.role, actor.id))) {
      return jsonError("Role must be viewer, manager or admin.", 400);
    }
    if (typeof body.isActive === "boolean") {
      await setUserActive(pool, id, body.isActive, actor.id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(redactError(error, "Could not update that user."), 500);
  }
}
