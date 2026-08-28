import { NextRequest, NextResponse } from "next/server";
import { apiPortalUser } from "@/lib/auth/portal-api";
import { getPortalHomeReadModel } from "@/lib/data/portal-read-model";
import { jsonError, redactError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current-account portal context, scoped by its effective portal capabilities. */
export async function GET(request: NextRequest) {
  try {
    const authorized = await apiPortalUser();
    if (!authorized) return jsonError("Authentication required", 401);
    const month = request.nextUrl.searchParams.get("month");
    const data = await getPortalHomeReadModel(authorized.pool, authorized.access, month);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return jsonError(redactError(error, "Could not load portal access."), 500);
  }
}
