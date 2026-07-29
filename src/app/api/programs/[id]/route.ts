import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { updateProgram, type ProgramInput } from "@/lib/manage/programs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update a program. Passing `body.isActive` false archives it, true restores
 * it. Admin only.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("admin");
  if (!user) return jsonError("Administrator role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    const pool = getPool();
    const result = await updateProgram(
      pool,
      id,
      body as unknown as Partial<ProgramInput> & { isActive?: boolean },
      user.id,
      reason,
    );
    return resultResponse(result, 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
