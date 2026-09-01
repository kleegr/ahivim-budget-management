import { type NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { repairIssuedClassInvoiceProgramLink } from "@/lib/manage/class-invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await apiUser("admin");
  if (!user) return jsonError("Only the owner can repair a class invoice program link.", 403);
  const crossOrigin = sameOriginOrFail(request);
  if (crossOrigin) return crossOrigin;
  const [{ id }, body] = await Promise.all([params, readJson(request)]);
  try {
    return resultResponse(await repairIssuedClassInvoiceProgramLink(
      getPool(),
      id,
      {
        classBudgetPeriodId: String(body.classBudgetPeriodId ?? ""),
        reason: typeof body.reason === "string" ? body.reason : null,
      },
      user.id,
    ));
  } catch (error) {
    return jsonError(redactError(error, "The class invoice program link could not be repaired."), 500);
  }
}
