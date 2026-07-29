import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { listPrograms } from "@/lib/data/app-queries";
import { createProgram, type ProgramInput } from "@/lib/manage/programs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List every program, including archived ones. Any signed-in role may read. */
export async function GET() {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  try {
    const pool = getPool();
    const data = await listPrograms(pool);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/** Create a program. Admin only: programs drive rate configuration. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("admin");
  if (!user) return jsonError("Administrator role required", 403);

  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    const pool = getPool();
    const result = await createProgram(pool, body as unknown as ProgramInput, user.id, reason);
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
