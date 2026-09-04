import { type NextRequest } from "next/server";
import { accessibleClassInvoice } from "@/lib/class-route-helpers";
import { buildClassInvoicePdf } from "@/lib/documents/class-invoice-pdf";
import { jsonError, redactError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function filename(value: string): string {
  const safe = value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return `invoice-${safe || "classes"}.pdf`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    const preview = new URL(request.url).searchParams.get("preview") === "1";
    const found = await accessibleClassInvoice(id, preview ? "manage" : "view");
    if ("error" in found) return found.error as Response;
    if (found.invoice.status === "void") {
      return jsonError("Voided class invoices cannot be rendered.", 409);
    }
    if (found.invoice.status !== "issued" && !preview) {
      return jsonError("Only issued class invoices can be downloaded.", 409);
    }
    const bytes = await buildClassInvoicePdf(found.invoice, {
      draft: found.invoice.status === "draft",
    });
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `${preview ? "inline" : "attachment"}; filename="${filename(found.invoice.invoiceNumber)}"`,
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not build that class invoice PDF."), 500);
  }
}
