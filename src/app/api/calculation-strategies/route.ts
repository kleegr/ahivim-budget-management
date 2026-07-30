import { type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError } from "@/lib/http";
import { createStrategy } from "@/lib/manage/calculation-strategies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to add strategies.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  const result = await createStrategy(
    getPool(),
    { individualId: String(body.individualId ?? ""), label: body.label ? String(body.label) : undefined },
    user.id,
  );
  return resultResponse(result, 201);
}
