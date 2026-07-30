import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { listTables, LEDGER_TABLE } from "@/lib/db/migrate";
import { MIGRATIONS } from "@/lib/db/migrations.generated";
import { ensureMigrationsApplied } from "@/lib/db/auto-migrate";
import { ensurePostMigrationTasks } from "@/lib/db/post-migrate";
import { apiUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Schema health check.
 *
 * Anonymous / non-admin callers get only a boolean: is the database reachable
 * and are all migrations this build ships recorded as applied? No table names,
 * no migration names and no counts are exposed — a deploy can still confirm the
 * schema is current from `healthy: true` without leaking the schema shape.
 *
 * Signed-in admins additionally get the detailed table + migration listing,
 * which is useful when diagnosing a deployment.
 */
export async function GET() {
  const pool = getPool();

  // Bring the schema current on first request (idempotent, once per process),
  // so a fresh deployment reaches its expected schema without an operator. The
  // detailed outcome goes to the server log; the public surface stays a boolean.
  let migrate: Awaited<ReturnType<typeof ensureMigrationsApplied>> | null = null;
  try {
    migrate = await ensureMigrationsApplied();
    // One-time data tasks (e.g. the first name-match scan) after the schema is current.
    await ensurePostMigrationTasks();
  } catch {
    /* never let a maintenance attempt fail the health check */
  }

  // Health is computed server-side; only the boolean crosses the public surface.
  let healthy = false;
  try {
    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM ${LEDGER_TABLE}`);
    const applied = new Set(rows.map((r) => r.name));
    healthy = MIGRATIONS.length > 0 && MIGRATIONS.every((m) => applied.has(m.name));
  } catch {
    healthy = false;
  }

  const user = await apiUser("admin");
  if (!user) {
    // Public surface: healthy / not-healthy only, nothing about the schema shape.
    return NextResponse.json({ ok: true, healthy });
  }

  // Admin surface: full detail for diagnostics.
  try {
    const tables = await listTables(pool);
    let migrations: string[] = [];
    try {
      const { rows } = await pool.query<{ name: string }>(
        `SELECT name FROM ${LEDGER_TABLE} ORDER BY name`,
      );
      migrations = rows.map((r) => r.name);
    } catch {
      /* ledger not created yet — report an empty migration list */
    }
    return NextResponse.json({
      ok: true,
      healthy,
      migrate,
      tableCount: tables.length,
      migrationCount: migrations.length,
      expectedMigrationCount: MIGRATIONS.length,
      migrations,
      tables,
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Schema check failed" }, { status: 500 });
  }
}
