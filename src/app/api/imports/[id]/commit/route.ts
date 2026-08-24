import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { apiUser } from "@/lib/auth/session";
import { writeAudit } from "@/lib/auth/users";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";
import { commit } from "@/lib/import/service";
import { isUuid } from "@/lib/data/app-queries";
import { refreshSettlementObligations } from "@/lib/manage/settlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Commit a staged import.
 *
 * Manager or admin only. The whole write happens inside one transaction; if
 * any part of it fails the transaction is rolled back and nothing is written,
 * and this route reports that explicitly rather than returning a partial count.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const user = await apiUser("manager");
  if (!user) return jsonError("You need the manager role to commit an import.", 403);

  const { id } = await params;
  if (!isUuid(id)) return jsonError("Not found", 404);

  const pool = getPool();
  try {
    const outcome = await commit(pool, id, user.id);
    if (!outcome.ok) {
      return NextResponse.json(
        { ok: false, error: outcome.message, reason: outcome.reason },
        { status: outcome.reason === "not_found" ? 404 : 409 },
      );
    }

    await writeAudit(pool, {
      userId: user.id,
      action: outcome.result.alreadyCommitted ? "import_commit_noop" : "import_committed",
      entityType: "import_batch",
      entityId: outcome.result.importBatchId,
      metadata: {
        importedFileId: outcome.result.importedFileId,
        counts: outcome.result.counts,
        reconciled: outcome.result.reconciliation.reconciled,
      },
    }).catch(() => undefined);

    // Settlement calculations are derived and re-runnable, just like payment
    // attribution. A failure here never changes the successful import; the
    // dashboard's Refresh action can retry it without duplicating obligations.
    const settlementRefresh = outcome.result.alreadyCommitted
      ? null
      : await refreshSettlementObligations(pool, {}, user.id);

    return NextResponse.json({
      ok: true,
      alreadyCommitted: outcome.result.alreadyCommitted,
      importBatchId: outcome.result.importBatchId,
      importedFileId: outcome.result.importedFileId,
      counts: outcome.result.counts,
      reconciliation: outcome.result.reconciliation,
      note: outcome.result.note,
      settlements: settlementRefresh?.ok ? settlementRefresh.data : null,
      settlementWarning: settlementRefresh && !settlementRefresh.ok
        ? settlementRefresh.message
        : null,
    });
  } catch (error) {
    await writeAudit(pool, {
      userId: user.id,
      action: "import_commit_failed",
      entityType: "imported_file",
      entityId: id,
      metadata: { message: redactError(error) },
    }).catch(() => undefined);
    return NextResponse.json(
      {
        ok: false,
        error: redactError(error, "The commit failed and was rolled back. Nothing was written."),
        rolledBack: true,
      },
      { status: 500 },
    );
  }
}
