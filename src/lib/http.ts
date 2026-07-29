import { NextRequest, NextResponse } from "next/server";

/**
 * Defence in depth against cross-site requests.
 *
 * The session cookie is SameSite=Lax, which already stops a cross-site form
 * POST from carrying it. This adds an explicit Origin check so a mutating
 * route rejects the request outright rather than running as an anonymous user.
 */
export function sameOriginOrFail(request: NextRequest): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return null; // same-origin form posts and server-side calls omit it
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
  const expected = request.headers.get("host");
  if (expected && host !== expected) {
    return NextResponse.json({ ok: false, error: "Cross-origin request rejected" }, { status: 403 });
  }
  return null;
}

/** Strip anything that could carry a connection string out of an error. */
export function redactError(error: unknown, fallback = "Unexpected error"): string {
  const raw = error instanceof Error ? error.message : fallback;
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[connection string redacted]")
    .replace(/\b[A-Za-z0-9._%+-]+:[^@\s/]+@[A-Za-z0-9.-]+/g, "[credentials redacted]")
    .slice(0, 300);
}

export const jsonError = (message: string, status: number) =>
  NextResponse.json({ ok: false, error: message }, { status });

import type { Result } from "@/lib/manage/errors";
import { STATUS } from "@/lib/manage/errors";

/** Map a service Result to a NextResponse, so route handlers stay tiny. */
export function resultResponse<T>(result: Result<T>, okStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json({ ok: true, data: result.data }, { status: okStatus });
  return NextResponse.json({ ok: false, error: result.message, code: result.code }, {
    status: STATUS[result.code],
  });
}

/** Parse a JSON body defensively; always returns an object. */
export async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}
