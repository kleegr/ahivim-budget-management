import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { readJson, resultResponse, sameOriginOrFail, jsonError, redactError } from "@/lib/http";
import { updateProgramRules, type ProgramRulesInput } from "@/lib/manage/program-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asBool = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;

/** "" / null → null (clear); a number → the integer; otherwise leave untouched. */
const asIntOrNull = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
};

const asNumStrOrNull = (v: unknown): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === "string") return v.trim() || null;
  return undefined;
};

/**
 * Edit a program's rule flags. Only the fields present in the body are changed.
 * Admin only: these rules drive one-to-one vs group behaviour, the money split,
 * rate overrides and what an authorization must specify.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("admin");
  if (!user) return jsonError("Administrator role required", 403);

  const { id } = await params;
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason : null;

  const rules: ProgramRulesInput = {};
  if ("oneToOneRequired" in body) rules.oneToOneRequired = asBool(body.oneToOneRequired);
  if ("groupsAllowed" in body) rules.groupsAllowed = asBool(body.groupsAllowed);
  if ("maxGroupSize" in body) rules.maxGroupSize = asIntOrNull(body.maxGroupSize);
  if ("allowMultipleEmployees" in body) rules.allowMultipleEmployees = asBool(body.allowMultipleEmployees);
  if ("allowMultipleIndividuals" in body) rules.allowMultipleIndividuals = asBool(body.allowMultipleIndividuals);
  if ("allowIndividualRateOverride" in body)
    rules.allowIndividualRateOverride = asBool(body.allowIndividualRateOverride);
  if ("selfHireConverts" in body) rules.selfHireConverts = asBool(body.selfHireConverts);
  if ("agencyAdditionalRate" in body) rules.agencyAdditionalRate = asNumStrOrNull(body.agencyAdditionalRate);
  if ("requiredAuthType" in body && typeof body.requiredAuthType === "string")
    rules.requiredAuthType = body.requiredAuthType;

  try {
    const result = await updateProgramRules(getPool(), id, rules, user.id, reason);
    return resultResponse(result, 200);
  } catch (error) {
    return jsonError(redactError(error), 500);
  }
}
