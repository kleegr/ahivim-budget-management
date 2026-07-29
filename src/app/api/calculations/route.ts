import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { saveCalculation, type SaveCalculationInput } from "@/lib/manage/calculations";
import { coerceCalculationInput } from "./preview/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Compute and persist a calculation for an individual, superseding the prior
 * active one. Manager or admin only — this writes a revision and audits it.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const body = await readJson(request);
  const reason = asStr(body.reason) ?? null;

  const input: SaveCalculationInput = {
    ...coerceCalculationInput(body),
    individualId: asStr(body.individualId) ?? "",
    programId: asStr(body.programId) ?? null,
    budgetPeriodId: asStr(body.budgetPeriodId) ?? null,
    spreadsheetValue: asStr(body.spreadsheetValue) ?? null,
    effectiveFrom: asStr(body.effectiveFrom) ?? null,
    notes: asStr(body.notes) ?? null,
  };

  try {
    const result = await saveCalculation(getPool(), input, user.id, reason);
    return resultResponse(result, 201);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
