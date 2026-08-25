import { type NextRequest, NextResponse } from "next/server";
import {
  apiClassFinancialUser,
  canAccessClassIndividual,
} from "@/lib/auth/class-financial-access";
import { classResultResponse } from "@/lib/class-response";
import { getClassBudget } from "@/lib/data/class-invoices";
import { jsonError, readJson, redactError, sameOriginOrFail } from "@/lib/http";
import { updateClassBudget } from "@/lib/manage/class-invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function accessibleBudget(id: string, mode: "view" | "manage") {
  const access = await apiClassFinancialUser(mode);
  if (!access) return { error: jsonError(mode === "view" ? "Class financial access required" : "Class invoice management access required", 403) };
  const budget = await getClassBudget(access.pool, id);
  if (!budget) return { error: jsonError("That class budget was not found.", 404) };
  if (!canAccessClassIndividual(access.scope, budget.individualId)) {
    return { error: jsonError("You do not have access to that individual's class finances.", 403) };
  }
  return { access, budget };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const found = await accessibleBudget(id, "view");
    if (found.error) return found.error;
    return NextResponse.json({ ok: true, data: found.budget });
  } catch (error) {
    return jsonError(redactError(error, "Could not load that class budget."), 500);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  try {
    const found = await accessibleBudget(id, "manage");
    if (found.error) return found.error;
    const body = await readJson(request);
    const status = body.status === "active" || body.status === "closed" ? body.status : null;
    return classResultResponse(await updateClassBudget(found.access.pool, id, {
      label: body.label === undefined ? undefined : String(body.label),
      authorizedAmount: body.authorizedAmount === undefined ? undefined : String(body.authorizedAmount),
      status: body.status === undefined ? undefined : status,
      notes: body.notes === undefined ? undefined : body.notes === null ? null : String(body.notes),
      overBudgetOverrideReason: typeof body.overBudgetOverrideReason === "string" ? body.overBudgetOverrideReason : null,
    }, found.access.user.id, typeof body.reason === "string" ? body.reason : null));
  } catch (error) {
    return jsonError(redactError(error, "Could not update that class budget."), 500);
  }
}
