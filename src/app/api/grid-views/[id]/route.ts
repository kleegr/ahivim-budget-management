import { type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { resultResponse, sameOriginOrFail, jsonError } from "@/lib/http";
import { deleteGridView } from "@/lib/manage/grid-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to delete views.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  const grid = request.nextUrl.searchParams.get("grid") ?? "";
  const result = await deleteGridView(getPool(), { gridKey: grid, id }, user.id);
  return resultResponse(result);
}
