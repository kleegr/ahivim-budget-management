import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { previewSession, type SessionDraft } from "@/lib/manage/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Non-mutating: return the warnings, expected billing and per-individual
 * forecast for a draft session so the form can show live figures. Any signed-in
 * role may preview; nothing is written.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const body = await readJson(request);
  const draft: SessionDraft = {
    employeeId: asString(body.employeeId) ?? null,
    programId: asString(body.programId) ?? "",
    individualIds: asStringArray(body.individualIds),
    sessionDate: asString(body.sessionDate) ?? "",
    startTime: asString(body.startTime) ?? null,
    endTime: asString(body.endTime) ?? null,
    durationHours: asString(body.durationHours) ?? "",
  };
  const excludeSessionId = asString(body.excludeSessionId) ?? null;

  if (!/^[0-9a-f-]{36}$/i.test(draft.programId) || draft.individualIds.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(draft.sessionDate)) {
    return NextResponse.json({ ok: true, data: { durationHours: "0", warnings: [], billing: null, forecast: [] } });
  }

  try {
    const pool = getPool();
    const preview = await previewSession(pool, draft, excludeSessionId);
    return NextResponse.json({ ok: true, data: preview });
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
