import { type NextRequest, NextResponse } from "next/server";
import {
  apiClassFinancialUser,
  canAccessClassIndividual,
} from "@/lib/auth/class-financial-access";
import { classResultResponse } from "@/lib/class-response";
import { listClassBudgets } from "@/lib/data/class-invoices";
import { jsonError, readJson, redactError, sameOriginOrFail } from "@/lib/http";
import { createClassBudget } from "@/lib/manage/class-invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await apiClassFinancialUser("view");
  if (!access) return jsonError("Class financial access required", 403);
  const statusValue = request.nextUrl.searchParams.get("status");
  const status = statusValue === "active" || statusValue === "closed" ? statusValue : null;
  try {
    return NextResponse.json({
      ok: true,
      data: await listClassBudgets(access.pool, access.scope, {
        individualId: request.nextUrl.searchParams.get("individualId"),
        status,
      }),
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not load class budgets."), 500);
  }
}

export async function POST(request: NextRequest) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const access = await apiClassFinancialUser("manage");
  if (!access) return jsonError("Class invoice management access required", 403);
  const body = await readJson(request);
  const individualId = String(body.individualId ?? "");
  if (!canAccessClassIndividual(access.scope, individualId)) {
    return jsonError("You do not have access to that individual's class finances.", 403);
  }
  try {
    return classResultResponse(await createClassBudget(access.pool, {
      individualId,
      label: typeof body.label === "string" ? body.label : null,
      startDate: String(body.startDate ?? ""),
      endDate: String(body.endDate ?? ""),
      authorizedAmount: String(body.authorizedAmount ?? ""),
      notes: typeof body.notes === "string" ? body.notes : null,
    }, access.user.id, typeof body.reason === "string" ? body.reason : null), 201);
  } catch (error) {
    return jsonError(redactError(error, "Could not create that class budget."), 500);
  }
}
