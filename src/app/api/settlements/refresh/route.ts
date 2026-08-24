import { type NextRequest } from "next/server";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { refreshSettlementObligations } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await apiUser("manager");
  if (!user) return jsonError("You do not have permission to refresh settlements.", 403);
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const body = await readJson(request);
  try {
    const result = await refreshSettlementObligations(
      getPool(),
      {
        employeeId: body.employeeId ? String(body.employeeId) : null,
        individualId: body.individualId ? String(body.individualId) : null,
      },
      user.id,
    );
    return resultResponse(result);
  } catch (error) {
    return jsonError(redactError(error, "Settlement items could not be refreshed."), 500);
  }
}
