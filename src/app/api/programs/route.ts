import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { resolveAccessScope } from "@/lib/auth/access";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { listPrograms } from "@/lib/data/app-queries";
import {
  createProgram,
  createProgramSetup,
  type ProgramInput,
  type ProgramSetupInput,
} from "@/lib/manage/programs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List every program for an authorized internal workspace, including archived ones. */
export async function GET() {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  try {
    const pool = getPool();
    const scope = await resolveAccessScope(pool, user);
    // Portal-only accounts use their relationship-scoped portal read model and
    // must not be able to enumerate the agency-wide catalog through this
    // internal endpoint. Planning and financial staff still need the catalog;
    // each rate category remains independently redacted below.
    if (!scope.full && !scope.canSeeHours && !scope.canSeeMoney) {
      return jsonError("No access to programs", 403);
    }
    const data = await listPrograms(pool);
    return NextResponse.json({
      ok: true,
      data: data.map((program) => ({
        ...program,
        agencyRate: scope.canSeeBilledAmounts ? program.agencyRate : null,
        internalRate: scope.canSeeEmployeeAmounts ? program.internalRate : null,
      })),
    });
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
    const result = body.guidedSetup === true
      ? await createProgramSetup(pool, body as unknown as ProgramSetupInput, user.id, reason)
      : await createProgram(pool, body as unknown as ProgramInput, user.id, reason);
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
