import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { writeAudit } from "@/lib/auth/users";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";
import { listImports } from "@/lib/data/app-queries";
import { maxUploadBytes, uploadAndStage } from "@/lib/import/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** List uploads. Any signed-in role may read. */
export async function GET() {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);
  try {
    return NextResponse.json({ ok: true, imports: await listImports(getPool(), 100) });
  } catch (error) {
    return jsonError(redactError(error, "Could not list imports."), 500);
  }
}

/**
 * Upload a workbook. Manager or admin only: staging writes an imported_files
 * row and is the first step of a workflow that ends in financial records.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("You need the manager role to upload a workbook.", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Send the workbook as multipart/form-data with a `file` field.", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError("No file was attached. Choose an .xlsx workbook and try again.", 400);
  }
  if (file.size > maxUploadBytes()) {
    return jsonError(
      `That file is larger than the ${Math.round(maxUploadBytes() / 1024 / 1024)} MB upload limit.`,
      413,
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const pool = getPool();

  try {
    const outcome = await uploadAndStage(pool, {
      filename: file.name,
      bytes,
      uploadedByUserId: user.id,
    });

    if (!outcome.ok) {
      await writeAudit(pool, {
        userId: user.id,
        action: "import_upload_rejected",
        entityType: "imported_file",
        entityId: outcome.fileId ?? null,
        metadata: { filename: file.name, reason: outcome.reason },
      }).catch(() => undefined);
      const status = outcome.reason === "too_large" ? 413 : outcome.reason === "wrong_type" ? 415 : 409;
      return NextResponse.json(
        { ok: false, error: outcome.message, reason: outcome.reason, fileId: outcome.fileId ?? null },
        { status: outcome.reason === "unparseable" ? 422 : status },
      );
    }

    await writeAudit(pool, {
      userId: user.id,
      action: "import_staged",
      entityType: "imported_file",
      entityId: outcome.fileId,
      metadata: {
        filename: file.name,
        checksumSha256: outcome.checksum,
        sourceRows: outcome.staging.totalSourceRows,
        counts: outcome.staging.counts,
      },
    }).catch(() => undefined);

    return NextResponse.json(
      {
        ok: true,
        fileId: outcome.fileId,
        checksumSha256: outcome.checksum,
        totalSourceRows: outcome.staging.totalSourceRows,
        counts: outcome.staging.counts,
        reconciliation: outcome.staging.reconciliation,
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(redactError(error, "The workbook could not be staged."), 500);
  }
}
