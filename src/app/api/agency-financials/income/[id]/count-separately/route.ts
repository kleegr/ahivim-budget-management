import { type NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import {
  countManualIncomeSeparately,
  type AutomaticIncomeSourceType,
  type IncomeMatchingDecisionAction,
} from "@/lib/manage/agency-financials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await apiUser("admin");
  if (!user) return jsonError("Only the owner can count agency income separately.", 403);
  const crossOrigin = sameOriginOrFail(request);
  if (crossOrigin) return crossOrigin;
  const [{ id }, body] = await Promise.all([params, readJson(request)]);
  try {
    return resultResponse(await countManualIncomeSeparately(
      getPool(),
      id,
      {
        action: String(body.action ?? "count_separately") as IncomeMatchingDecisionAction,
        sourceType: String(body.sourceType ?? "") as AutomaticIncomeSourceType,
        sourceId: String(body.sourceId ?? ""),
        reason: String(body.reason ?? ""),
      },
      user.id,
    ));
  } catch (error) {
    return jsonError(redactError(error, "The income decision could not be saved."), 500);
  }
}
