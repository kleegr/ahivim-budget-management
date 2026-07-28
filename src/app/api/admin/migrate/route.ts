import { NextRequest, NextResponse } from "next/server";
import { runMigrations, ledgerExists, listTables } from "@/lib/db/migrate";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Runs outstanding migrations against the configured database.
 *
 * Authorisation, in order:
 *   1. the MIGRATION_TOKEN header, or
 *   2. a ONE-TIME first-run bootstrap, permitted only while the migration
 *      ledger table does not yet exist AND no MIGRATION_TOKEN is configured.
 *
 * The bootstrap path closes permanently the moment the ledger is created, so it
 * cannot be replayed. It exists because the very first migration has to run
 * before any administrator account can exist. Set MIGRATION_TOKEN in the
 * deployment environment to disable it entirely.
 */
export async function POST(request: NextRequest) {
  const configuredToken = process.env.MIGRATION_TOKEN?.trim();
  const providedToken = request.headers.get("x-migration-token")?.trim();

  let authorisedBy: string;

  if (configuredToken && providedToken && safeEqual(configuredToken, providedToken)) {
    authorisedBy = "migration_token";
  } else if (!configuredToken && !(await ledgerExists())) {
    authorisedBy = "first_run_bootstrap";
  } else {
    return NextResponse.json(
      { ok: false, reason: "Not authorised. Send a valid x-migration-token header." },
      { status: 401 },
    );
  }

  try {
    const result = await runMigrations();
    const tables = await listTables();
    return NextResponse.json({
      ok: true,
      authorisedBy,
      applied: result.applied,
      skipped: result.skipped,
      outcomes: result.outcomes,
      tableCount: tables.length,
      tables,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        reason: (error instanceof Error ? error.message : "Migration failed")
          .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[connection string redacted]")
          .slice(0, 500),
      },
      { status: 500 },
    );
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
