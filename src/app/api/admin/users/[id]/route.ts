import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import {
  setUserActive,
  setUserRole,
  setUserPassword,
  listUsers,
  getUserAccessConfig,
  setUserAccessConfig,
  type UserAccessConfig,
} from "@/lib/auth/users";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";
import { isUuid } from "@/lib/data/app-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCESS_KEYS = [
  "accessScope",
  "seeAllIndividuals",
  "seeAllEmployees",
  "canSeeTransactions",
  "individualIds",
  "employeeIds",
] as const;

/** One user's full access configuration (for the admin edit panel). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await apiUser("admin");
  if (!actor) return jsonError("Administrator role required", 403);
  const { id } = await params;
  if (!isUuid(id)) return jsonError("Not found", 404);
  try {
    const access = await getUserAccessConfig(getPool(), id);
    if (!access) return jsonError("Not found", 404);
    return NextResponse.json({ ok: true, access });
  } catch (error) {
    return jsonError(redactError(error, "Could not load that user."), 500);
  }
}

/**
 * Change a user's role, enabled state, ACCESS SCOPE, or reset their password.
 *
 * Two guards that matter: an administrator cannot demote or disable their own
 * account (which would lock them out mid-session), and the last remaining
 * enabled administrator cannot be removed, which would leave the installation
 * with no way back in. Access-scope and password changes only ever target
 * OTHER accounts through this route (an admin manages their own password on the
 * Settings page).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const actor = await apiUser("admin");
  if (!actor) return jsonError("Administrator role required", 403);

  const { id } = await params;
  if (!isUuid(id)) return jsonError("Not found", 404);
  if (id === actor.id) {
    return jsonError("You cannot change your own role, access or account state here.", 409);
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

    // Access scope — merge any provided fields over the user's current config so a
    // partial update never silently clears the rest.
    if (ACCESS_KEYS.some((k) => k in body)) {
      const current = await getUserAccessConfig(pool, id);
      const merged: UserAccessConfig = {
        accessScope:
          body.accessScope === "scoped" ? "scoped" : body.accessScope === "full" ? "full" : current?.accessScope ?? "full",
        seeAllIndividuals:
          typeof body.seeAllIndividuals === "boolean" ? body.seeAllIndividuals : current?.seeAllIndividuals ?? false,
        seeAllEmployees:
          typeof body.seeAllEmployees === "boolean" ? body.seeAllEmployees : current?.seeAllEmployees ?? false,
        canSeeTransactions:
          typeof body.canSeeTransactions === "boolean" ? body.canSeeTransactions : current?.canSeeTransactions ?? true,
        individualIds: Array.isArray(body.individualIds) ? body.individualIds.map(String) : current?.individualIds ?? [],
        employeeIds: Array.isArray(body.employeeIds) ? body.employeeIds.map(String) : current?.employeeIds ?? [],
      };
      await setUserAccessConfig(pool, id, merged, actor.id);
    }

    // Admin password reset (hand out a new credential).
    if (typeof body.password === "string" && body.password.length > 0) {
      const reset = await setUserPassword(pool, id, body.password, actor.id);
      if (!reset.ok) {
        return jsonError(
          reset.reason === "too_short" ? "Choose a password of at least 10 characters." : "Not found",
          reset.reason === "too_short" ? 400 : 404,
        );
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(redactError(error, "Could not update that user."), 500);
  }
}
