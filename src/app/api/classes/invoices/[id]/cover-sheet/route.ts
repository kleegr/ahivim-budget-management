import { type NextRequest, NextResponse } from "next/server";
import { accessibleClassInvoice } from "@/lib/class-route-helpers";
import {
  getClassCoverSheetSnapshot,
  getClassReimbursementProfile,
  getClassCoverVersion,
  listClassCoverVersions,
} from "@/lib/data/class-reimbursement-profiles";
import { buildClassCoverSheetPdf } from "@/lib/documents/class-cover-sheet-pdf";
import { jsonError, readJson, redactError, sameOriginOrFail } from "@/lib/http";
import { appendClassCoverCorrection, createClassCoverSheetSnapshot } from "@/lib/manage/class-reimbursement-profiles";
import { STATUS } from "@/lib/manage/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function filename(value: string): string {
  const safe = value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return `reimbursement-${safe || "classes"}.pdf`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    const found = await accessibleClassInvoice(id, "manage");
    if ("error" in found) return found.error as Response;
    const preview = new URL(request.url).searchParams.get("preview") === "1";
    const query = new URL(request.url).searchParams;
    const versions = await listClassCoverVersions(found.access.pool, id);
    const version = query.has("version") ? Number(query.get("version")) : versions[0]?.version ?? 1;
    if (!Number.isInteger(version) || version < 1) return jsonError("Choose a valid cover version.", 400);
    const frozen = versions.length ? await getClassCoverVersion(found.access.pool, id, version) : null;
    if (query.has("version") && !frozen) return jsonError("That finalized cover version was not found.", 404);
    if (query.get("metadata") === "1") return NextResponse.json({ ok: true, data: {
      profile: frozen ?? (found.invoice.status === "void" ? null : await getClassReimbursementProfile(found.access.pool, found.invoice.individualId)),
      finalized: Boolean(frozen), version, versions,
    } });
    if (found.invoice.status !== "issued" && found.invoice.status !== "void" && !(preview && found.invoice.status === "draft")) {
      return jsonError("Preview a draft cover sheet, or issue the invoice before downloading its finalized cover sheet.", 409);
    }
    const profile = frozen ?? (preview && found.invoice.status !== "void"
      ? await getClassReimbursementProfile(found.access.pool, found.invoice.individualId)
      : await getClassCoverSheetSnapshot(found.access.pool, found.invoice.id));
    if (versions.length && !frozen) return jsonError("That finalized cover version was not found.", 404);
    if (!profile) {
      return jsonError(
        preview ? "Save the reimbursement profile before previewing it." : "Finalize this cover sheet before downloading it.",
        409,
      );
    }
    const bytes = await buildClassCoverSheetPdf(found.invoice, profile);
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
    const body = await readJson(request);
    if (body.action === "append_correction") {
      if (typeof body.expectedProfileUpdatedAt !== "string" || body.expectedProfileUpdatedAt !== current.updatedAt) {
        return jsonError("The reusable profile changed. Reload it before appending this cover correction.", 409);
      }
      const correction = await appendClassCoverCorrection(found.access.pool, id, current, found.access.user.actorId,
        Number(body.expectedVersion), String(body.reason ?? ""));
      if (!correction.ok) return jsonError(correction.message, STATUS[correction.code]);
      return NextResponse.json({ ok: true, data: { version: correction.data.version,
        href: `/api/classes/invoices/${id}/cover-sheet?version=${correction.data.version}` } });
    }
    const created = await createClassCoverSheetSnapshot(
      found.access.pool,
      found.invoice.id,
      current,
      found.access.user.actorId,
    );
    if (!created.ok) return jsonError(created.message, STATUS[created.code]);
    return NextResponse.json({
      ok: true,
      data: { href: `/api/classes/invoices/${found.invoice.id}/cover-sheet?version=1` },
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not finalize that reimbursement cover sheet."), 500);
  }
}
