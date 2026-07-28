import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runMigrations, listTables } from "@/lib/db/migrate";
import { apiUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { writeAudit } from "@/lib/auth/users";
import { jsonError, redactError, sameOriginOrFail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Apply outstanding migrations.
 *
 * Authorisation is now one of exactly two things:
 *   1. a signed-in administrator, or
 *   2. the MIGRATION_TOKEN header, for a database that has no administrator
 *      yet (a brand-new deployment) or for automated deploys.
 *
 * The previous revision also allowed an UNAUTHENTICATED "first run" call while
 * the migration ledger did not exist. On a publicly reachable deployment that
 * is a race anyone can win, so it has been removed. A brand-new database is
 * initialised either by setting MIGRATION_TOKEN or by running
 * `npm run db:migrate` against it directly.
 *
 * The migration runner itself is idempotent: each file is applied once, inside
 * its own transaction, recorded in _ahivim_migrations with a checksum, and
 * skipped on every later run.
 */
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;

  const configuredToken = process.env.MIGRATION_TOKEN?.trim();
  const providedToken = request.headers.get("x-migration-token")?.trim();

  let authorisedBy: string;
  let actorId: string | null = null;

  if (configuredToken && providedToken && safeEqual(configuredToken, providedToken)) {
    authorisedBy = "migration_token";
  } else {
    const user = await apiUser("admin").catch(() => null);
    if (!user) {
      return jsonError(
        "Not authorised. Sign in as an administrator, or send a valid x-migration-token header.",
        401,
      );
    }
    authorisedBy = "admin_session";
    actorId = user.id;
  }

  try {
    const result = await runMigrations();
    const tables = await listTables();
    await writeAudit(getPool(), {
      userId: actorId,
      action: "migrations_run",
      entityType: "database",
      metadata: { authorisedBy, applied: result.applied, skipped: result.skipped },
    }).catch(() => undefined);

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
    return NextResponse.json({ ok: false, reason: redactError(error, "Migration failed") }, {
      status: 500,
    });
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
