import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import {
  createUser,
  listUsersWithAccess,
  setUserAccessConfig,
  userAccessConfigFromInput,
} from "@/lib/auth/users";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";

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
        canSeeCheckNet: u.canSeeCheckNet,
        canSeeTaxes: u.canSeeTaxes,
        canSeeBudgets: u.canSeeBudgets,
        canSeeEmployeeDeals: u.canSeeEmployeeDeals,
        canSeeSettlements: u.canSeeSettlements,
        canPlan: u.canPlan,
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
    );
    if (!outcome.ok) return jsonError(REASONS[outcome.reason] ?? "Could not create that user.", 400);

    // Apply the access configuration (scope only ever bites for the viewer role,
    // but we store it as chosen so the setting persists if the role changes).
    await setUserAccessConfig(pool, outcome.user.id, userAccessConfigFromInput(body, role), actor.id);

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
