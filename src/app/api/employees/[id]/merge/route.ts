import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { mergeEmployees, listEmployeeMergeCandidates } from "@/lib/manage/employee-merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Candidate duplicate employees to fold into this one. Manager only. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);
  const { id } = await params;
  const q = request.nextUrl.searchParams.get("q");
  try {
    const data = await listEmployeeMergeCandidates(getPool(), id, q);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}

/** Merge another employee (body.mergeId) INTO this one (the survivor). Manager only. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);
  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;
  const result = await mergeEmployees(getPool(), { keepId: id, mergeId: String(body.mergeId ?? "") }, user.id, reason);
  return resultResponse(result, 200);
}
