import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { addProgramRate } from "@/lib/manage/programs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Add an effective-dated rate to a program. Admin only. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("admin");
  if (!user) return jsonError("Administrator role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    const pool = getPool();
    const result = await addProgramRate(
      pool,
      id,
      {
        effectiveFrom: body.effectiveFrom as string,
        internalRate: body.internalRate as string,
        agencyRate: (body.agencyRate ?? null) as string | null,
        notes: (body.notes ?? null) as string | null,
      },
      user.id,
      reason,
    );
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
