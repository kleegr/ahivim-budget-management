import { type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, sameOriginOrFail, jsonError } from "@/lib/http";
import { NextResponse } from "next/server";
import { setSetting } from "@/lib/manage/app-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["dashboard", "transactions", "individuals", "calculations"]);

export async function POST(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to change this.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  const value = String(body.value ?? "");
  if (!ALLOWED.has(value)) {
    return jsonError("Choose Home, Transactions, People & budgets, or Financial setup.", 400);
  }
  await setSetting(getPool(), "default_landing", value, user.id);
  return NextResponse.json({ ok: true, data: { value } });
}
