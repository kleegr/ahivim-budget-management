import { NextResponse } from "next/server";
import { CONNECTION_ENV_CANDIDATES, resolveConnectionEnvName } from "@/lib/db";
import { hasDocumentStorage } from "@/lib/documents/document-storage";
import { googleSheetsCredentials } from "@/lib/sheets/writeback";
import { currentUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reports whether the minimum runtime configuration is present. Anonymous
 * callers receive one aggregate boolean; signed-in administrators can inspect
 * the individual presence flags. No secret value is ever returned.
 *
 * This exists so an operator (or a deployment check) can confirm the Neon
 * variable is wired up without anyone reading the connection string.
 */
export async function GET() {
  const databaseConnectionVariable = resolveConnectionEnvName();
  const configured = databaseConnectionVariable !== null;
  const isAdmin = await currentUser()
    .then((user) => user?.role === "admin")
    .catch(() => false);

  if (!isAdmin) {
    return NextResponse.json({ ok: true, configured, detail: "public" });
  }

  const present: Record<string, boolean> = {};
  for (const name of CONNECTION_ENV_CANDIDATES) {
    present[name] = Boolean(process.env[name]?.trim());
  }

  return NextResponse.json({
    ok: true,
    configured,
    detail: "administrator",
    databaseConnectionVariable,
    candidatesPresent: present,
    authSecretConfigured: Boolean(process.env.AUTH_SECRET?.trim()),
    migrationTokenConfigured: Boolean(process.env.MIGRATION_TOKEN?.trim()),
    cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
    googleSheetWritebackConfigured: googleSheetsCredentials() !== null,
    bootstrapAdminConfigured: Boolean(process.env.BOOTSTRAP_ADMIN_EMAIL?.trim()),
    documentStorageConfigured: hasDocumentStorage(),
    nodeEnv: process.env.NODE_ENV ?? null,
  });
}
