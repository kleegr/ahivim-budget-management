import { NextResponse } from "next/server";
import { CONNECTION_ENV_CANDIDATES, resolveConnectionEnvName } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reports which environment variables are PRESENT. Never their values.
 *
 * This exists so an operator (or a deployment check) can confirm the Neon
 * variable is wired up without anyone reading the connection string.
 */
export async function GET() {
  const present: Record<string, boolean> = {};
  for (const name of CONNECTION_ENV_CANDIDATES) {
    present[name] = Boolean(process.env[name]?.trim());
  }

  return NextResponse.json({
    databaseConnectionVariable: resolveConnectionEnvName(),
    candidatesPresent: present,
    authSecretConfigured: Boolean(process.env.AUTH_SECRET?.trim()),
    migrationTokenConfigured: Boolean(process.env.MIGRATION_TOKEN?.trim()),
    cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
    bootstrapAdminConfigured: Boolean(process.env.BOOTSTRAP_ADMIN_EMAIL?.trim()),
    nodeEnv: process.env.NODE_ENV ?? null,
  });
}
