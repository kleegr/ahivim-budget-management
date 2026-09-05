import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import {
  createUser,
  listUsersWithAccess,
} from "@/lib/auth/users";
import { provisionUser } from "@/lib/auth/provision-user";
import { jsonError, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REASONS: Record<string, string> = {
  duplicate_email: "An account with that email address already exists.",
  too_short: "Choose a password of at least 10 characters.",
  invalid_role: "Role must be viewer, manager or admin.",
  invalid_email: "That is not a valid email address.",
};

/** Administrators only. Password hashes are never returned. */
export async function GET() {
  const user = await apiUser("admin");
  if (!user) return jsonError("Administrator role required", 403);
  try {
    const users = await listUsersWithAccess(getPool());
    return NextResponse.json({
      ok: true,
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        isActive: u.isActive,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
        accessScope: u.accessScope,
        seeAllIndividuals: u.seeAllIndividuals,
        seeAllEmployees: u.seeAllEmployees,
        canSeeTransactions: u.canSeeTransactions,
        canSeeMoney: u.canSeeMoney,
        canSeeHours: u.canSeeHours,
        canSeeBilledAmounts: u.canSeeBilledAmounts,
        canSeeEmployeeAmounts: u.canSeeEmployeeAmounts,
        canSeeAgencySpread: u.canSeeAgencySpread,
        canSeeCheckGross: u.canSeeCheckGross,
        canSeeCheckNet: u.canSeeCheckNet,
        canSeeTaxes: u.canSeeTaxes,
        canSeeBudgets: u.canSeeBudgets,
        canSeeEmployeeDeals: u.canSeeEmployeeDeals,
        canSeeSettlements: u.canSeeSettlements,
        canManageSettlements: u.canManageSettlements,
        canSeeClassFinancials: u.canSeeClassFinancials,
        canManageClassInvoices: u.canManageClassInvoices,
        canViewDocuments: u.canViewDocuments,
        canEditDocuments: u.canEditDocuments,
        canPlan: u.canPlan,
        canManagePlanning: u.canManagePlanning,
        accountPreset: u.accountPreset,
        portalManaged: u.portalManaged,
        individualCount: u.individualCount,
        employeeCount: u.employeeCount,
      })),
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not list users."), 500);
  }
}

export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const actor = await apiUser("admin");
  if (!actor) return jsonError("Administrator role required", 403);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const pool = getPool();
  try {
    if ("preset" in body) {
      const result = await provisionUser(pool, {
        preset: typeof body.preset === "string" ? body.preset : "",
        email: String(body.email ?? ""),
        displayName: String(body.displayName ?? ""),
        password: String(body.password ?? ""),
        individualId: typeof body.individualId === "string" ? body.individualId : undefined,
        relationship: typeof body.relationship === "string" ? body.relationship : undefined,
        employeeId: typeof body.employeeId === "string" ? body.employeeId : undefined,
        agencyId: typeof body.agencyId === "string" ? body.agencyId : undefined,
        internalAccess: body.internalAccess,
        capabilityGrants: body.capabilityGrants as string[] | undefined,
        capabilityDenials: body.capabilityDenials as string[] | undefined,
        reason: typeof body.reason === "string" ? body.reason : null,
      }, actor.id);
      if (!result.ok) return resultResponse(result);
      return NextResponse.json({ ok: true, user: result.data }, { status: 201 });
    }

    const role = String(body.role ?? "viewer");
    const outcome = await createUser(
      pool,
      {
        email: String(body.email ?? ""),
        displayName: String(body.displayName ?? ""),
        password: String(body.password ?? ""),
        role,
      },
      actor.id,
      body,
    );
    if (!outcome.ok) return jsonError(REASONS[outcome.reason] ?? "Could not create that user.", 400);

    return NextResponse.json(
      {
        ok: true,
        user: {
          id: outcome.user.id,
          email: outcome.user.email,
          displayName: outcome.user.displayName,
          role: outcome.user.role,
          isActive: outcome.user.isActive,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(redactError(error, "Could not create that user."), 500);
  }
}
