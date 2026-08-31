import { type NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { voidManualIncomeEntry } from "@/lib/manage/agency-financials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await apiUser("admin");
  if (!user) return jsonError("Only the owner can void agency income.", 403);
  const crossOrigin = sameOriginOrFail(request);
  if (crossOrigin) return crossOrigin;
  const [{ id }, body] = await Promise.all([params, readJson(request)]);
  try {
    return resultResponse(await voidManualIncomeEntry(
      getPool(),
      id,
      user.id,
      String(body.reason ?? ""),
    ));
  } catch (error) {
    return jsonError(redactError(error, "The income could not be voided."), 500);
  }
}
