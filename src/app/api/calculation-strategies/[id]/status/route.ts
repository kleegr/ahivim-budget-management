import { type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError } from "@/lib/http";
import { setStrategyStatus } from "@/lib/manage/calculation-strategies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to change strategies.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  const body = await readJson(request);
  const status = body.status === "archived" ? "archived" : "active";
  const result = await setStrategyStatus(getPool(), { id, status }, user.id);
  return resultResponse(result);
}
