import { NextResponse } from "next/server";
import { getPool, resolveConnectionEnvName } from "@/lib/db";
import { listTables, tableCounts, ledgerExists } from "@/lib/db/migrate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live database connectivity check.
 *
 * Errors are reduced to a short message before they leave the server, because a
 * driver error can otherwise echo the host and credentials back to the caller.
 */
export async function GET() {
  const envName = resolveConnectionEnvName();
  if (!envName) {
    return NextResponse.json(
      { connected: false, reason: "No database connection variable is set on this deployment." },
      { status: 503 },
    );
  }

  try {
    const started = Date.now();
    const { rows } = await getPool().query<{ now: string; version: string }>(
      "SELECT now()::text AS now, version() AS version",
    );
    const tables = await listTables();
    const migrated = await ledgerExists();
    const counts = migrated ? await tableCounts(tables) : {};

    return NextResponse.json({
      connected: true,
      connectionVariable: envName, // the NAME only
      latencyMs: Date.now() - started,
      serverTime: rows[0]?.now ?? null,
      serverVersion: rows[0]?.version?.split(" ").slice(0, 2).join(" ") ?? null,
      migrationsApplied: migrated,
      tableCount: tables.length,
      tables,
      rowCounts: counts,
    });
  } catch (error) {
    return NextResponse.json(
      { connected: false, connectionVariable: envName, reason: summarise(error) },
      { status: 503 },
    );
  }
}

/** Strip anything that could carry a host or credential out of a driver error. */
function summarise(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown error";
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[connection string redacted]")
    .replace(/password=[^\s&"']+/gi, "password=[redacted]")
    .slice(0, 300);
}
