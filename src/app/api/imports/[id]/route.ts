import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { writeAudit } from "@/lib/auth/users";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";
import { discard, loadFile, restage } from "@/lib/import/service";
import { getImport, isUuid, listImportWarnings } from "@/lib/data/app-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const user = await apiUser("viewer");
  if (!user) return jsonError("Authentication required", 401);

  const { id } = await params;
  if (!isUuid(id)) return jsonError("Not found", 404);

  try {
    const pool = getPool();
    const file = await loadFile(pool, id);
    if (!file) return jsonError("Not found", 404);

    const summary = await getImport(pool, id);
    const staging = file.payload ? await restage(pool, file.payload) : null;
    const warnings = file.committedBatchId
      ? await listImportWarnings(pool, file.committedBatchId, 200)
      : [];

    return NextResponse.json({
      ok: true,
      file: {
        id: file.id,
        filename: file.filename,
        byteSize: file.byteSize,
        checksumSha256: file.checksum,
        uploadedAt: file.uploadedAt,
        templateDetected: file.templateDetected,
        status: file.batchStatus ?? (file.payload ? "staged" : "unknown"),
      },
      summary,
      staging: staging
        ? {
            totalSourceRows: staging.totalSourceRows,
            counts: staging.counts,
            reconciliation: staging.reconciliation,
            unknownProgramLabels: staging.unknownProgramLabels,
            unmatchedIndividualNames: staging.unmatchedIndividualNames,
            unmatchedEmployeeNames: staging.unmatchedEmployeeNames,
            warnings: staging.warnings.slice(0, 200),
          }
        : null,
      warnings,
    });
  } catch (error) {
    return jsonError(redactError(error, "Could not load that import."), 500);
  }
}

/** Discard a staged upload. Never removes anything already committed. */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("You need the manager role to discard an import.", 403);

  const { id } = await params;
  if (!isUuid(id)) return jsonError("Not found", 404);

  try {
    const pool = getPool();
    const outcome = await discard(pool, id);
    if (!outcome.ok) {
      return NextResponse.json(
        { ok: false, error: outcome.message },
        { status: outcome.reason === "not_found" ? 404 : 409 },
      );
    }
    await writeAudit(pool, {
      userId: user.id,
      action: "import_discarded",
      entityType: "imported_file",
      entityId: id,
    }).catch(() => undefined);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(redactError(error, "Could not discard that import."), 500);
  }
}
