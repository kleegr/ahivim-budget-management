import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db";
import type { PgLikePool } from "@/lib/import/commit";
import { ensureMigrationsApplied } from "@/lib/db/auto-migrate";
import { getSetting, setSetting } from "@/lib/manage/app-settings";
import { getSyncConfig } from "@/lib/sheets/config";
import { runSheetSync } from "@/lib/sheets/sync";
import { apiUser } from "@/lib/auth/session";
import { jsonError, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BOOTSTRAP_FLAG = "initial_sheet_sync_done";

/** The most recent run and the live ledger totals, for deploy verification. */
async function verification(pool: PgLikePool) {
  const { rows: runRows } = await pool.query(
    `SELECT trigger, status, source_rows, rows_added, rows_updated, rows_skipped,
            rows_flagged, rows_failed, reconciliation, error_message,
            started_at::text AS started_at, finished_at::text AS finished_at
       FROM sheet_sync_runs ORDER BY started_at DESC LIMIT 1`,
  );
  const { rows: totalRows } = await pool.query<{ txns: string; gross: string; internal: string }>(
    `SELECT count(*)::text AS txns,
            COALESCE(sum(imported_amount), 0)::text AS gross,
            COALESCE(sum(calculated_internal_amount), 0)::text AS internal
       FROM payroll_transactions`,
  );
  return { latestRun: runRows[0] ?? null, ledger: totalRows[0] ?? null };
}

/**
 * One-time initial sync bootstrap.
 *
 * Runs the very first full sync of the Google Sheet on a deployed instance,
 * exactly once, then becomes inert. This is a database-writing POST and always
 * requires either a signed-in administrator or the same explicit
 * `x-migration-token` used for first-deploy maintenance. A missing token never
 * opens an anonymous bootstrap window.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const authorization = await authorize(request);
  if (!authorization) return jsonError("Unauthorized", 401);

  // The bootstrap may be the first request after the deploy that shipped 0011.
  try {
    await ensureMigrationsApplied();
  } catch {
    /* the sync will surface a clear error if the schema is not ready */
  }

  const pool = getPool();
  const done = await getSetting<boolean>(pool, BOOTSTRAP_FLAG);
  if (done) {
    return NextResponse.json({
      ok: true,
      alreadyDone: true,
      note: "The initial sync has already run.",
      authorisedBy: authorization.authorisedBy,
      ...(await verification(pool)),
    });
  }

  const config = await getSyncConfig(pool);
  const summary = await runSheetSync(pool, {
    trigger: "initial",
    userId: authorization.actorId,
    config,
  });

  if (summary.status !== "failed") {
    await setSetting(pool, BOOTSTRAP_FLAG, true, authorization.actorId);
  }

  return NextResponse.json({
    ok: summary.status !== "failed",
    status: summary.status,
    authorisedBy: authorization.authorisedBy,
    summary,
    ...(await verification(pool)),
  });
}

async function authorize(request: NextRequest): Promise<{
  authorisedBy: "migration_token" | "admin_session";
  actorId: string | null;
} | null> {
  const configuredToken = process.env.MIGRATION_TOKEN?.trim();
  const providedToken = request.headers.get("x-migration-token")?.trim();
  if (configuredToken && providedToken && safeEqual(configuredToken, providedToken)) {
    return { authorisedBy: "migration_token", actorId: null };
  }

  const user = await apiUser("admin").catch(() => null);
  return user ? { authorisedBy: "admin_session", actorId: user.actorId } : null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
