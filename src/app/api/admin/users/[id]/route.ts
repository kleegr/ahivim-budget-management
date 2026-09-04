import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import {
  accountPresetMatchesRole,
  isRole,
  listUsers,
  getUserAccessConfig,
  updateManagedUser,
  userAccessConfigFromInput,
  type UserAccessConfig,
} from "@/lib/auth/users";
import {
  getAccountPreset,
  isAccountPresetId,
  type AccountPresetId,
} from "@/lib/auth/account-presets";
import { jsonError, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { isUuid } from "@/lib/data/app-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCESS_KEYS = [
  "accessScope",
  "seeAllIndividuals",
  "seeAllEmployees",
  "canSeeTransactions",
  "canSeeMoney",
  "canSeeHours",
  "canSeeBilledAmounts",
  "canSeeEmployeeAmounts",
  "canSeeAgencySpread",
  "canSeeCheckNet",
  "canSeeTaxes",
  "canSeeBudgets",
  "canSeeEmployeeDeals",
  "canSeeSettlements",
  "canManageSettlements",
  "canSeeClassFinancials",
  "canManageClassInvoices",
  "canEditDocuments",
  "canPlan",
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

    if (typeof body.role === "string" && !isRole(body.role)) {
      return jsonError("Role must be viewer, manager or admin.", 400);
    }
    const requestedRole = typeof body.role === "string" && isRole(body.role)
      ? body.role
      : target.role;
    const presetSubmitted = "preset" in body;
    if (presetSubmitted && (typeof body.preset !== "string" || !isAccountPresetId(body.preset))) {
      return jsonError("Choose a valid account role.", 400);
    }
    const requestedPreset = presetSubmitted ? body.preset as AccountPresetId : undefined;
    const requestedPresetDefinition = requestedPreset ? getAccountPreset(requestedPreset) : null;
    if (
      requestedPresetDefinition
      && requestedPresetDefinition.binding.kind !== "none"
      && requestedPresetDefinition.binding.kind !== "owner"
    ) {
      return jsonError("Portal-linked account presets must be managed in Portal administration.", 400);
    }
    if (requestedPreset && !accountPresetMatchesRole(requestedPreset, requestedRole)) {
      return jsonError("That account preset is not compatible with the selected role.", 400);
    }
    const accessSubmitted = ACCESS_KEYS.some((key) => key in body);
    let access: UserAccessConfig | undefined;
    if (typeof body.role === "string" || accessSubmitted) {
      if (requestedRole === "viewer") {
        // A viewer request must explicitly include accessScope="scoped". Any
        // omitted or stale full-scope manager payload is reduced to the locked
        // viewer defaults by the server parser.
        access = userAccessConfigFromInput(body, requestedRole);
      } else if (accessSubmitted) {
        const current = await getUserAccessConfig(pool, id);
        const mergedInput: Record<string, unknown> = {
          ...(current ?? {}),
          ...body,
          individualIds: Array.isArray(body.individualIds)
            ? body.individualIds.map(String)
            : current?.individualIds ?? [],
          employeeIds: Array.isArray(body.employeeIds)
            ? body.employeeIds.map(String)
            : current?.employeeIds ?? [],
        };
        access = userAccessConfigFromInput(mergedInput, requestedRole);
      }
    }

    const hasPassword = typeof body.password === "string" && body.password.length > 0;
    if (
      typeof body.role === "string"
      || presetSubmitted
      || accessSubmitted
      || typeof body.isActive === "boolean"
      || hasPassword
    ) {
      const outcome = await updateManagedUser(pool, id, {
        role: typeof body.role === "string" || accessSubmitted ? requestedRole : undefined,
        accountPreset: requestedPreset,
        access,
        isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
        password: hasPassword ? body.password as string : undefined,
      }, actor.id);
      if (!outcome.ok) return resultResponse(outcome);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(redactError(error, "Could not update that user."), 500);
  }
}
