import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { listMergeCandidates, mergeIndividuals } from "@/lib/manage/individual-merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Candidate records that could be the same person as this individual — for
 * connecting a budgeted person to transactions billed under a different name.
 * Manager or admin only (it drives a data-merge).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  const q = request.nextUrl.searchParams.get("q");
  try {
    const candidates = await listMergeCandidates(getPool(), id, q);
    return NextResponse.json({ ok: true, data: candidates });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/**
 * Fold another individual (body.mergeId) into this one: every transaction and
 * plan that referenced the other name is repointed here, the old spelling is
 * remembered as an approved alias, and the folded-in row is archived. Manager or
 * admin only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const mergeId = typeof body.mergeId === "string" ? body.mergeId : "";
  const reason = typeof body.reason === "string" ? body.reason : "Connected from the individual profile";

  try {
    const result = await mergeIndividuals(getPool(), { keepId: id, mergeId }, user.id, reason);
    return resultResponse(result, 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
