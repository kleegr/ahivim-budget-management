import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser, clearSessionCookie } from "@/lib/auth/session";
import { changePassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/users";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REASONS: Record<string, string> = {
  not_found: "That account no longer exists.",
  incorrect_current: "Your current password is incorrect.",
  too_short: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
  reused: "The new password must be different from the current one.",
};

/** Change your own password. Signing out afterwards forces a fresh sign-in. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return jsonError("Provide both your current password and a new password.", 400);
  }

  try {
    const result = await changePassword(getPool(), user.id, currentPassword, newPassword);
    if (!result.ok) {
      return jsonError(REASONS[result.reason] ?? "Password could not be changed.", 400);
    }
  } catch (error) {
    return jsonError(redactError(error, "Password could not be changed."), 500);
  }

  await clearSessionCookie();
  return NextResponse.json({
    ok: true,
    message: "Password changed. Sign in again with your new password.",
  });
}
