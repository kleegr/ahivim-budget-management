import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { listTables, LEDGER_TABLE } from "@/lib/db/migrate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public schema health check. Reports the table count and which migrations the
 * live database has recorded — no authentication, no secrets, no business data.
 * Lets a deploy confirm the database reached the expected schema over a plain
 * GET (the mutating migrate endpoint stays admin/token protected).
 */
export async function GET() {
  try {
    const pool = getPool();
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
      tableCount: tables.length,
      migrationCount: migrations.length,
      migrations,
      tables,
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Schema check failed" }, { status: 500 });
  }
}
