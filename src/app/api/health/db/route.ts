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
 * call it before anyone can sign in. That is also why the anonymous response
 * is deliberately thin: connectivity, latency, whether migrations are applied,
 * and how many tables exist.
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
      { connected: false, reason: "No database connection variable is set on this deployment." },
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
    const tables = await listTables();
    const migrated = await ledgerExists();

    const body: Record<string, unknown> = {
      connected: true,
      connectionVariable: envName, // the NAME only, never the value
      latencyMs: Date.now() - started,
      serverTime: rows[0]?.now ?? null,
      migrationsApplied: migrated,
      tableCount: tables.length,
      detail: isAdmin ? "administrator" : "public",
    };

    if (isAdmin) {
      body.serverVersion = rows[0]?.version?.split(" ").slice(0, 2).join(" ") ?? null;
      body.tables = tables;
      body.rowCounts = migrated ? await tableCounts(tables) : {};
    }

    return NextResponse.json(body);
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
