import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { scanMatches } from "@/lib/manage/individual-merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Scan for near-duplicate individuals and queue every candidate for human review. */
export async function POST(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to run a match scan.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  try {
    const result = await scanMatches(getPool(), user.id);
    if (!result.ok) return jsonError(result.message, 400);
    return NextResponse.json({ ok: true, data: result.data });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
