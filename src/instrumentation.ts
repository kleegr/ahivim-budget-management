/**
 * FIRST-BOOT BOOTSTRAP
 * ====================
 *
 * Runs once per server start (Next.js instrumentation hook, Node runtime).
 * Exists because this deployment environment has no shell access to Neon:
 * the only place the database is reachable is the deployed runtime itself.
 *
 * What it does, and the guard on each step:
 *
 *  1. Apply migrations — ONLY while the migration ledger table does not exist
 *     (a genuinely uninitialised database). Once the ledger exists this path
 *     never runs again; later migrations require the authenticated
 *     POST /api/admin/migrate with MIGRATION_TOKEN.
 *  2. Create the first administrator — ONLY while the users table is empty.
 *     Uses BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD when set;
 *     otherwise generates a strong random password and prints it ONCE to the
 *     server log (visible only to the Vercel project's own team) with an
 *     instruction to rotate it immediately. No credential is ever stored in
 *     the repository or returned by any endpoint.
 *
 * Failures are logged and swallowed: a broken bootstrap must not take the
 * whole app down, and every step can be retried on the next cold start.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { resolveConnectionEnvName } = await import("@/lib/db");
    if (!resolveConnectionEnvName()) {
      console.warn("[bootstrap] No database connection variable set; skipping bootstrap.");
      return;
    }

    const { ledgerExists, runMigrations, listTables } = await import("@/lib/db/migrate");

    const migrated = await ledgerExists();
    if (!migrated) {
      console.log("[bootstrap] Uninitialised database detected; applying migrations…");
      const result = await runMigrations();
      const tables = await listTables();
      console.log(
        `[bootstrap] Migrations: applied ${result.applied}, skipped ${result.skipped}; ` +
          `${tables.length} tables present.`,
      );
    }

    await bootstrapAdmin();
  } catch (error) {
    console.error(
      "[bootstrap] Bootstrap failed (will retry on next cold start):",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

async function bootstrapAdmin() {
  const { getPool } = await import("@/lib/db");
  const pool = getPool();

  const { rows } = await pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM "users"`);
  if (Number(rows[0]?.c ?? 0) > 0) return;

  const { hashPassword, generatePassword } = await import("@/lib/auth/crypto");

  const email =
    process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() || "admin@ahivim.local";
  const provided = process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim();
  const password = provided && provided.length >= 10 ? provided : generatePassword();
  const passwordHash = await hashPassword(password);

  await pool.query(
    `INSERT INTO "users" ("email", "display_name", "password_hash", "role")
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT DO NOTHING`,
    [email, "Administrator", passwordHash],
  );

  await pool.query(
    `INSERT INTO "audit_logs" ("action", "entity_type", "metadata")
     VALUES ('bootstrap_admin_created', 'user', $1)`,
    [JSON.stringify({ email, passwordSource: provided ? "env" : "generated" })],
  );

  if (provided && provided.length >= 10) {
    console.log(`[bootstrap] Administrator ${email} created from BOOTSTRAP_ADMIN_* variables.`);
  } else {
    // Printed once, to the project team's private runtime log, because there is
    // no other channel to hand over the first credential in this environment.
    console.log("[bootstrap] ============================================================");
    console.log(`[bootstrap] First administrator created: ${email}`);
    console.log(`[bootstrap] One-time initial password: ${password}`);
    console.log("[bootstrap] Sign in and CHANGE THIS PASSWORD IMMEDIATELY (Settings).");
    console.log("[bootstrap] This password is not stored anywhere and will not be shown again.");
    console.log("[bootstrap] ============================================================");
  }
}
