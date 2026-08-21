import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { getAccountOptions, setAccountOptions } from "@/lib/data/masser-sheet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The editable account-tag dropdown list for the Masser board. Managers only. */
export async function GET() {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);
  try {
    return NextResponse.json({ ok: true, data: await getAccountOptions(getPool()) });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

export async function PUT(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  try {
    const body = await readJson(request);
    const options = Array.isArray(body.options) ? body.options.map((o: unknown) => String(o ?? "")) : [];
    const saved = await setAccountOptions(getPool(), options, user.id);
    return NextResponse.json({ ok: true, data: saved });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
