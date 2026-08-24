import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { authenticate, writeAudit } from "@/lib/auth/users";
import { createSessionCookie, safeRedirectPath } from "@/lib/auth/session";
import { sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign in. There is no public signup: this endpoint only ever verifies
 * credentials against an existing account (or performs the one-time
 * BOOTSTRAP_ADMIN_* creation while the users table is empty).
 *
 * Failures are deliberately indistinguishable from one another so the response
 * cannot be used to enumerate valid email addresses.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  let email = "";
  let password = "";
  let next: string | null = null;
  let wantsJson = false;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    wantsJson = true;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    email = typeof body.email === "string" ? body.email : "";
    password = typeof body.password === "string" ? body.password : "";
    next = typeof body.next === "string" ? body.next : null;
  } else {
    const form = await request.formData();
    email = String(form.get("email") ?? "");
    password = String(form.get("password") ?? "");
    const rawNext = form.get("next");
    next = typeof rawNext === "string" ? rawNext : null;
  }

  const destination = safeRedirectPath(next, "/home");

  if (!email.trim() || !password) {
    return fail(request, wantsJson, "Enter both an email address and a password.", destination);
  }

  const pool = getPool();
  let outcome;
  try {
    outcome = await authenticate(pool, email, password);
  } catch {
    return fail(
      request,
      wantsJson,
      "The sign-in service is temporarily unavailable. Try again shortly.",
      destination,
      503,
    );
  }

  if (!outcome.ok) {
    await writeAudit(pool, {
      action: "login_failed",
      entityType: "user",
      metadata: { email: email.trim().toLowerCase(), reason: outcome.reason },
    }).catch(() => undefined);
    const message =
      outcome.reason === "account_disabled"
        ? "That account has been disabled. Ask an administrator to re-enable it."
        : "Email address or password is incorrect.";
    return fail(request, wantsJson, message, destination, 401);
  }

  await createSessionCookie(outcome.user);
  await writeAudit(pool, {
    userId: outcome.user.id,
    action: outcome.bootstrapped ? "bootstrap_admin_signed_in" : "login_succeeded",
    entityType: "user",
    entityId: outcome.user.id,
  }).catch(() => undefined);

  if (wantsJson) {
    return NextResponse.json({
      ok: true,
      user: {
        id: outcome.user.id,
        email: outcome.user.email,
        displayName: outcome.user.displayName,
        role: outcome.user.role,
      },
      redirectTo: destination,
    });
  }
  return NextResponse.redirect(new URL(destination, request.nextUrl.origin), { status: 303 });
}

function fail(
  request: NextRequest,
  wantsJson: boolean,
  message: string,
  destination: string,
  status = 400,
) {
  if (wantsJson) return NextResponse.json({ ok: false, error: message }, { status });
  const url = new URL("/signin", request.nextUrl.origin);
  url.searchParams.set("error", message);
  if (destination !== "/dashboard") url.searchParams.set("next", destination);
  return NextResponse.redirect(url, { status: 303 });
}
