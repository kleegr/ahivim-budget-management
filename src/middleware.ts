import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge middleware: a fast redirect layer only.
 *
 * The middleware checks for the *presence* of the session cookie and bounces
 * anonymous visitors to /signin. It deliberately does not try to verify the
 * signature here (the edge runtime lacks the synchronous node:crypto APIs the
 * session module uses). Every server component and API route performs full
 * cryptographic verification and role checks via requireSession/apiSession,
 * so a forged cookie gets past this redirect only to be rejected there.
 */

const PUBLIC_PATHS = new Set(["/signin"]);
const PUBLIC_API_PREFIXES = [
  "/api/auth/login",
  "/api/health/",
  "/api/admin/migrate",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }
  if (PUBLIC_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const hasCookie = request.cookies.has("ahivim_session");
  if (hasCookie) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const signin = request.nextUrl.clone();
  signin.pathname = "/signin";
  signin.search = "";
  return NextResponse.redirect(signin);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|css|js)$).*)"],
};
