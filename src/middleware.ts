import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge middleware: a fast redirect layer, and nothing else.
 *
 * It checks only for the PRESENCE of the session cookie. It deliberately does
 * not verify the signature, look anything up, or run any initialisation: the
 * Edge runtime has no node:crypto and no database, and doing security work in
 * two places invites the two places to disagree.
 *
 * Authority lives server-side. Every page calls requireUser() and every
 * protected API route calls apiUser(); both verify the cookie signature AND
 * re-read the account from the database. A forged or stale cookie gets past
 * this redirect only to be rejected there.
 */

const PUBLIC_PATHS = new Set(["/signin"]);

// The sync cron and one-time bootstrap must be reachable WITHOUT a session
// cookie: the Vercel Cron calls the endpoint with a CRON_SECRET bearer header
// (no cookie), and the bootstrap is a one-time self-service trigger. Both do
// their own authorization at the route level (CRON_SECRET / one-shot flag), so
// they are safe to let past this cookie-only redirect layer. The interactive
// sync routes (/api/sync/run, /config, /conflicts, /history) are NOT listed and
// stay behind the session check.
const PUBLIC_API_PREFIXES = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/health/",
  "/api/sync/cron",
  "/api/sync/bootstrap",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (PUBLIC_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return NextResponse.next();
  }

  if (request.cookies.has("ahivim_session")) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }

  const signin = request.nextUrl.clone();
  signin.pathname = "/signin";
  signin.search = "";
  // Bring the visitor back where they were aiming once they have signed in.
  if (pathname !== "/" && !pathname.startsWith("/_next")) {
    signin.searchParams.set("next", pathname);
  }
  return NextResponse.redirect(signin);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|css|js)$).*)"],
};
