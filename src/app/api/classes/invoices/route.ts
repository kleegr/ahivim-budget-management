import { type NextRequest, NextResponse } from "next/server";
import {
  apiClassFinancialUser,
  canAccessClassIndividual,
} from "@/lib/auth/class-financial-access";
import { classResultResponse } from "@/lib/class-response";
import { classInvoiceLinesFromRequest } from "@/lib/class-route-helpers";
import { getClassBudget, listClassInvoices } from "@/lib/data/class-invoices";
import { jsonError, readJson, redactError, sameOriginOrFail } from "@/lib/http";
import { createClassInvoiceDraft } from "@/lib/manage/class-invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const access = await apiClassFinancialUser("view");
  if (!access) return jsonError("Class financial access required", 403);
  const statusValue = request.nextUrl.searchParams.get("status");
  const status = statusValue === "draft" || statusValue === "issued" || statusValue === "void"
    ? statusValue
    : null;
  try {
    return NextResponse.json({
      ok: true,
      data: await listClassInvoices(access.pool, access.scope, {
        individualId: request.nextUrl.searchParams.get("individualId"),
        budgetId: request.nextUrl.searchParams.get("budgetId"),
        status,
      }),
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not load class invoices."), 500);
  }
}

export async function POST(request: NextRequest) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const access = await apiClassFinancialUser("manage");
  if (!access) return jsonError("Class invoice management access required", 403);
  const body = await readJson(request);
  const budgetId = String(body.classBudgetPeriodId ?? "");
  try {
    const budget = await getClassBudget(access.pool, budgetId);
    if (!budget) return jsonError("That class budget was not found.", 404);
    if (!canAccessClassIndividual(access.scope, budget.individualId)) {
      return jsonError("You do not have access to that individual's class finances.", 403);
    }
    return classResultResponse(await createClassInvoiceDraft(access.pool, {
      classBudgetPeriodId: budgetId,
      invoiceNumber: String(body.invoiceNumber ?? ""),
      invoiceDate: String(body.invoiceDate ?? ""),
      servicePeriodStart: String(body.servicePeriodStart ?? ""),
      servicePeriodEnd: String(body.servicePeriodEnd ?? ""),
      billToName: typeof body.billToName === "string" ? body.billToName : null,
      billToAddressLine1: typeof body.billToAddressLine1 === "string" ? body.billToAddressLine1 : null,
      billToAddressLine2: typeof body.billToAddressLine2 === "string" ? body.billToAddressLine2 : null,
      billToCityStateZip: typeof body.billToCityStateZip === "string" ? body.billToCityStateZip : null,
      purpose: typeof body.purpose === "string" ? body.purpose : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      lines: classInvoiceLinesFromRequest(body.lines),
    }, access.user.id, typeof body.reason === "string" ? body.reason : null), 201);
  } catch (error) {
    return jsonError(redactError(error, "Could not create that class invoice."), 500);
  }
}
