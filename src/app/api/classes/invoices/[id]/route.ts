import { type NextRequest, NextResponse } from "next/server";
import { classResultResponse } from "@/lib/class-response";
import {
  accessibleClassInvoice,
  classInvoiceLinesFromRequest,
} from "@/lib/class-route-helpers";
import { jsonError, readJson, redactError, sameOriginOrFail } from "@/lib/http";
import { discardClassInvoiceDraft, updateClassInvoiceDraft } from "@/lib/manage/class-invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const found = await accessibleClassInvoice(id, "view");
    if (found.error) return found.error;
    return NextResponse.json({ ok: true, data: found.invoice });
  } catch (error) {
    return jsonError(redactError(error, "Could not load that class invoice."), 500);
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
    const found = await accessibleClassInvoice(id, "manage");
    if (found.error) return found.error;
    const body = await readJson(request);
    return classResultResponse(await updateClassInvoiceDraft(found.access.pool, id, {
      invoiceNumber: body.invoiceNumber === undefined ? undefined : String(body.invoiceNumber),
      invoiceDate: body.invoiceDate === undefined ? undefined : String(body.invoiceDate),
      servicePeriodStart: body.servicePeriodStart === undefined ? undefined : String(body.servicePeriodStart),
      servicePeriodEnd: body.servicePeriodEnd === undefined ? undefined : String(body.servicePeriodEnd),
      billToName: body.billToName === undefined ? undefined : body.billToName === null ? null : String(body.billToName),
      billToAddressLine1: body.billToAddressLine1 === undefined ? undefined : body.billToAddressLine1 === null ? null : String(body.billToAddressLine1),
      billToAddressLine2: body.billToAddressLine2 === undefined ? undefined : body.billToAddressLine2 === null ? null : String(body.billToAddressLine2),
      billToCityStateZip: body.billToCityStateZip === undefined ? undefined : body.billToCityStateZip === null ? null : String(body.billToCityStateZip),
      purpose: body.purpose === undefined ? undefined : body.purpose === null ? null : String(body.purpose),
      notes: body.notes === undefined ? undefined : body.notes === null ? null : String(body.notes),
      lines: body.lines === undefined ? undefined : classInvoiceLinesFromRequest(body.lines),
    }, found.access.user.id, typeof body.reason === "string" ? body.reason : null));
  } catch (error) {
    return jsonError(redactError(error, "Could not update that class invoice."), 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  try {
    const found = await accessibleClassInvoice(id, "manage");
    if (found.error) return found.error;
    const body = await readJson(request);
    return classResultResponse(await discardClassInvoiceDraft(
      found.access.pool,
      id,
      found.access.user.id,
      typeof body.reason === "string" ? body.reason : null,
    ));
  } catch (error) {
    return jsonError(redactError(error, "Could not discard that class invoice draft."), 500);
  }
}
