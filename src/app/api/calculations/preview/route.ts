import { NextRequest, NextResponse } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { readJson, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { previewCalculation } from "@/lib/manage/calculations";
import type { CalculationInput } from "@/lib/business/calculation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Numeric-ish inputs arrive as strings or numbers; keep them as strings and
 *  fold empty/missing to undefined so the pure engine sees clean input. */
const asStr = (v: unknown): string | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === "string") return v.trim() || undefined;
  return undefined;
};

const asMonths = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : undefined;
};

/** Build a CalculationInput from a loosely-typed request body. */
export function coerceCalculationInput(body: Record<string, unknown>): CalculationInput {
  return {
    annualAuthorizedHours: asStr(body.annualAuthorizedHours) ?? null,
    annualAuthorizedDollars: asStr(body.annualAuthorizedDollars) ?? null,
    programRate: asStr(body.programRate) ?? "0",
    individualRateOverride: asStr(body.individualRateOverride) ?? null,
    agencyRate: asStr(body.agencyRate) ?? null,
    agencyAdditionalPerHour: asStr(body.agencyAdditionalPerHour) ?? null,
    months: asMonths(body.months),
    basis: body.basis === "monthly" ? "monthly" : body.basis === "annual" ? "annual" : undefined,
    cut1Percent: asStr(body.cut1Percent) ?? null,
    cut2Percent: asStr(body.cut2Percent) ?? null,
    cutOrder:
      body.cutOrder === "parallel" ? "parallel" : body.cutOrder === "sequential" ? "sequential" : undefined,
    clockAdjustment: asStr(body.clockAdjustment) ?? null,
    netAdjustment: asStr(body.netAdjustment) ?? null,
    afterAllAdjustment: asStr(body.afterAllAdjustment) ?? null,
  };
}

/**
 * Run the Calculation engine without persisting, so the workspace can show a
 * live, fully-explained preview. Any signed-in role may compute one.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("Manager role required", 403);

  const body = await readJson(request);
  try {
    const data = previewCalculation(coerceCalculationInput(body));
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    // A half-typed or non-numeric field reaches the engine as garbage; report
    // it as a bad request rather than a server error.
    return jsonError(redactError(error, "Those inputs could not be calculated."), 400);
  }
}
