import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { setTransactionsPaid } from "@/lib/manage/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mark transactions paid/unpaid. Body: { ids: string[], paid: boolean, note?: string }.
 * One id or many (bulk "mark selected as paid"). Manager or admin only.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const body = await readJson(request);
  const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const paid = body.paid === true;
  const note = typeof body.note === "string" ? body.note : undefined;

  try {
    const result = await setTransactionsPaid(getPool(), { ids, paid, note }, user.id);
    return resultResponse(result, 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
