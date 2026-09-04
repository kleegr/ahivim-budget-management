import { NextResponse } from "next/server";
import { getPool, resolveConnectionEnvName } from "@/lib/db";
import { listTables, tableCounts, ledgerExists } from "@/lib/db/migrate";
import { currentUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live database connectivity check.
 *
 * Readable without a session, because a deployment check has to be able to
 * call it before anyone can sign in. The anonymous response is deliberately
 * limited to connectivity and migration health.
 *
 * The table NAMES and the per-table ROW COUNTS are operational detail — a
 * complete map of the schema and how much data is in each part of it — and are
 * returned only to a signed-in administrator. An earlier revision published
 * all of it anonymously.
 *
 * Errors are reduced to a short message before they leave the server, because
 * a driver error can otherwise echo the host and credentials back to the caller.
 */
export async function GET() {
  const envName = resolveConnectionEnvName();
  if (!envName) {
    return NextResponse.json(
      { ok: false, connected: false, reason: "Database is not configured." },
      { status: 503 },
    );
  }

  let isAdmin = false;
  try {
    isAdmin = (await currentUser())?.role === "admin";
  } catch {
    isAdmin = false;
  }

  try {
    const started = Date.now();
    const { rows } = await getPool().query<{ now: string; version: string }>(
      "SELECT now()::text AS now, version() AS version",
    );
    const migrated = await ledgerExists();

    const body: Record<string, unknown> = {
      ok: true,
      connected: true,
      migrationsApplied: migrated,
      detail: isAdmin ? "administrator" : "public",
    };

    if (isAdmin) {
      const tables = await listTables();
      body.connectionVariable = envName; // the NAME only, never the value
      body.latencyMs = Date.now() - started;
      body.serverTime = rows[0]?.now ?? null;
      body.tableCount = tables.length;
      body.serverVersion = rows[0]?.version?.split(" ").slice(0, 2).join(" ") ?? null;
      body.tables = tables;
      body.rowCounts = migrated ? await tableCounts(tables) : {};
    }

    return NextResponse.json(body);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        connected: false,
        reason: isAdmin ? summarise(error) : "Database check failed.",
        ...(isAdmin ? { connectionVariable: envName } : {}),
      },
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
