import { type NextRequest, NextResponse } from "next/server";
import {
  apiClassFinancialUser,
  canAccessClassIndividual,
} from "@/lib/auth/class-financial-access";
import { getClassReimbursementProfile } from "@/lib/data/class-reimbursement-profiles";
import {
  jsonError,
  readJson,
  redactError,
  resultResponse,
  sameOriginOrFail,
} from "@/lib/http";
import { saveClassReimbursementProfile } from "@/lib/manage/class-reimbursement-profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function accessProfile(individualId: string, mode: "view" | "manage") {
  const access = await apiClassFinancialUser(mode);
  if (!access) return { error: jsonError("Class financial access required", 403) };
  if (!canAccessClassIndividual(access.scope, individualId)) {
    return { error: jsonError("You do not have access to this class profile.", 403) };
  }
  return { access };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ individualId: string }> },
): Promise<Response> {
  const { individualId } = await params;
  try {
    const found = await accessProfile(individualId, "manage");
    if ("error" in found) return found.error as Response;
    const profile = await getClassReimbursementProfile(found.access.pool, individualId);
    if (!profile) return jsonError("That individual was not found.", 404);
    return NextResponse.json({ ok: true, data: profile });
  } catch (error) {
    return jsonError(redactError(error, "Could not load the reimbursement profile."), 500);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ individualId: string }> },
): Promise<Response> {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { individualId } = await params;
  try {
    const found = await accessProfile(individualId, "manage");
    if ("error" in found) return found.error as Response;
    const body = await readJson(request);
    return resultResponse(await saveClassReimbursementProfile(
      found.access.pool,
      individualId,
      {
        mailingName: body.mailingName === undefined ? undefined : typeof body.mailingName === "string" ? body.mailingName : null,
        addressLine1: body.addressLine1 === undefined ? undefined : typeof body.addressLine1 === "string" ? body.addressLine1 : null,
        addressLine2: body.addressLine2 === undefined ? undefined : typeof body.addressLine2 === "string" ? body.addressLine2 : null,
        cityStateZip: body.cityStateZip === undefined ? undefined : typeof body.cityStateZip === "string" ? body.cityStateZip : null,
        phone: body.phone === undefined ? undefined : typeof body.phone === "string" ? body.phone : null,
        dateOfBirth: body.dateOfBirth === undefined ? undefined : typeof body.dateOfBirth === "string" ? body.dateOfBirth : null,
        medicaidId: body.medicaidId === undefined ? undefined : typeof body.medicaidId === "string" ? body.medicaidId : null,
        fiscalIntermediary: body.fiscalIntermediary === undefined ? undefined : typeof body.fiscalIntermediary === "string" ? body.fiscalIntermediary : null,
        payableTo: body.payableTo === undefined ? undefined : typeof body.payableTo === "string" ? body.payableTo : null,
        lifePlanConfirmed: typeof body.lifePlanConfirmed === "boolean" ? body.lifePlanConfirmed : undefined,
        budgetCategory: body.budgetCategory === undefined ? undefined : typeof body.budgetCategory === "string" ? body.budgetCategory : null,
        formCompletedBy: body.formCompletedBy === undefined ? undefined : typeof body.formCompletedBy === "string" ? body.formCompletedBy : null,
        relationship: body.relationship === undefined ? undefined : typeof body.relationship === "string" ? body.relationship : null,
      },
      found.access.user.id,
      typeof body.reason === "string" ? body.reason : null,
    ));
  } catch (error) {
    return jsonError(redactError(error, "Could not save the reimbursement profile."), 500);
  }
}
