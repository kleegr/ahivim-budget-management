import { type NextRequest } from "next/server";
import { classResultResponse } from "@/lib/class-response";
import { accessibleClassInvoice } from "@/lib/class-route-helpers";
import { jsonError, readJson, redactError, sameOriginOrFail } from "@/lib/http";
import { voidClassInvoice } from "@/lib/manage/class-invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
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
    return classResultResponse(await voidClassInvoice(
      found.access.pool,
      id,
      found.access.user.id,
      String(body.reason ?? ""),
    ));
  } catch (error) {
    return jsonError(redactError(error, "Could not void that class invoice."), 500);
  }
}
