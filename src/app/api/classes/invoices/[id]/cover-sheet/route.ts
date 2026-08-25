import { type NextRequest, NextResponse } from "next/server";
import { accessibleClassInvoice } from "@/lib/class-route-helpers";
import {
  getClassCoverSheetSnapshot,
  getClassReimbursementProfile,
} from "@/lib/data/class-reimbursement-profiles";
import { buildClassCoverSheetPdf } from "@/lib/documents/class-cover-sheet-pdf";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";
import { createClassCoverSheetSnapshot } from "@/lib/manage/class-reimbursement-profiles";
import { STATUS } from "@/lib/manage/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function filename(value: string): string {
  const safe = value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return `reimbursement-${safe || "classes"}.pdf`;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    const found = await accessibleClassInvoice(id, "manage");
    if ("error" in found) return found.error as Response;
    if (found.invoice.status !== "issued") {
      return jsonError("Only issued class invoices can have reimbursement cover sheets.", 409);
    }
    const profile = await getClassCoverSheetSnapshot(found.access.pool, found.invoice.id);
    if (!profile) return jsonError("Finalize this cover sheet before downloading it.", 409);
    const bytes = await buildClassCoverSheetPdf(found.invoice, profile);
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename(found.invoice.invoiceNumber)}"`,
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not build that reimbursement cover sheet."), 500);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  try {
    const found = await accessibleClassInvoice(id, "manage");
    if ("error" in found) return found.error as Response;
    if (found.invoice.status !== "issued") {
      return jsonError("Only issued class invoices can have reimbursement cover sheets.", 409);
    }
    const current = await getClassReimbursementProfile(found.access.pool, found.invoice.individualId);
    if (!current) return jsonError("That reimbursement profile was not found.", 404);
    const created = await createClassCoverSheetSnapshot(
      found.access.pool,
      found.invoice.id,
      current,
      found.access.user.id,
    );
    if (!created.ok) return jsonError(created.message, STATUS[created.code]);
    return NextResponse.json({
      ok: true,
      data: { href: `/api/classes/invoices/${found.invoice.id}/cover-sheet` },
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not finalize that reimbursement cover sheet."), 500);
  }
}
