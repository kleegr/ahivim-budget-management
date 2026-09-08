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

const PUBLIC_OCR_ASSETS = new Set([
  "/tesseract/7.0.0/worker.min.js",
  "/tesseract/7.0.0/core/tesseract-core-lstm.wasm.js",
  "/tesseract/7.0.0/core/tesseract-core-simd-lstm.wasm.js",
  "/tesseract/7.0.0/core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "/tesseract/7.0.0/lang/eng.traineddata.gz",
]);

// These exact endpoints must be reachable WITHOUT a session cookie because
// they either are genuinely read-only health checks or authenticate the caller
// inside the route (for example Vercel Cron's bearer secret). Mutating routes
// on this list still fail closed at the route handler before doing any work.
// Exact matching prevents similarly named or unknown APIs from bypassing the
// normal cookie-presence redirect layer.
const PUBLIC_API_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/health/db",
  "/api/health/env",
  "/api/health/schema",
  "/api/health/xlsx",
  "/api/sync/cron",
  "/api/sync/bootstrap",
  // Vercel Blob calls this endpoint without the application's session cookie
  // after a direct upload. The route verifies Blob's signed callback itself;
  // browser token requests still require the normal session and capability.
  "/api/documents/uploads",
]);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_OCR_ASSETS.has(pathname)) return NextResponse.next();
  if (PUBLIC_PATHS.has(pathname) || pathname === "/api/auth/login" || pathname === "/api/auth/logout") return privateResponse(NextResponse.next());
  if (PUBLIC_API_PATHS.has(pathname)) return NextResponse.next();

  if (request.cookies.has("ahivim_session")) return privateResponse(NextResponse.next());

  if (pathname.startsWith("/api/")) {
    return privateResponse(NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 }));
  }

  const signin = request.nextUrl.clone();
  signin.pathname = "/signin";
  signin.search = "";
  // Bring the visitor back where they were aiming once they have signed in.
  if (pathname !== "/" && !pathname.startsWith("/_next")) {
    signin.searchParams.set("next", pathname);
  }
  return privateResponse(NextResponse.redirect(signin));
}

/** Identity changes must never reuse an earlier user's HTML, RSC or API body. */
function privateResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|css|js)$).*)"],
};
