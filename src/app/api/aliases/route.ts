import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { listAliases, createAlias, type AliasKind } from "@/lib/manage/aliases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List individual and employee aliases. Any signed-in role may read. */
export async function GET(request: NextRequest) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");
  const kind = kindParam === "individual" || kindParam === "employee" ? kindParam : undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;

  try {
    const pool = getPool();
    const data = await listAliases(pool, { kind, status, search });
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/** Create an alias mapping an imported spelling to a canonical record. Manager or admin only. */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    const pool = getPool();
    const result = await createAlias(
      pool,
      body.kind as AliasKind,
      {
        importedName: body.importedName as string,
        canonicalId: body.canonicalId as string,
        approve: body.approve as boolean | undefined,
      },
      user.id,
      reason,
    );
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
