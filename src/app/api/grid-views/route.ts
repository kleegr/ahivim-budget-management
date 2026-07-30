import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError } from "@/lib/http";
import { listGridViews, saveGridView } from "@/lib/manage/grid-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Sign in to continue.", 401);
  const grid = request.nextUrl.searchParams.get("grid") ?? "";
  if (!grid) return jsonError("A grid is required.", 400);
  const views = await listGridViews(getPool(), grid);
  return NextResponse.json({ ok: true, data: views });
}

export async function POST(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to save views.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  const result = await saveGridView(
    getPool(),
    {
      gridKey: String(body.gridKey ?? ""),
      name: String(body.name ?? ""),
      config: body.config,
    },
    user.id,
  );
  return resultResponse(result, 201);
}
