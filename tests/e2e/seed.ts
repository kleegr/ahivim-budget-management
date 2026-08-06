/**
 * End-to-end test seed. Standalone script, run with `tsx` from Playwright's
 * global setup (see global-setup.ts) — NOT imported by the Playwright runner.
 *
 * It resets the test database to exactly what a fresh deployment would have
 * (drop + recreate the schema, then apply the real migration files through the
 * application's own migration runner) and inserts a single administrator whose
 * password is hashed with the application's own scrypt helper. The interactive
 * sign-in form then authenticates against that record.
 *
 * It connects with `pg` directly, so it does NOT need the Neon WebSocket proxy;
 * only the running application does.
 *
 *   tsx tests/e2e/seed.ts
 */
import { Pool } from "pg";
import type { PgLikePool } from "../../src/lib/import/commit";
import { runMigrations } from "../../src/lib/db/migrate";
import { hashPassword } from "../../src/lib/auth/crypto";
import {
  TEST_DB_URL,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_DISPLAY_NAME,
} from "./fixtures";

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 4 });
  try {
    // A fresh deployment's schema, deterministically.
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    const result = await runMigrations(pool as unknown as PgLikePool);

    // One known administrator, hashed the way the app hashes.
    const passwordHash = await hashPassword(ADMIN_PASSWORD);
    await pool.query(
      `INSERT INTO users (email, display_name, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'admin', true)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, role = 'admin', is_active = true`,
      [ADMIN_EMAIL.toLowerCase(), ADMIN_DISPLAY_NAME, passwordHash],
    );

    const { rows } = await pool.query<{ c: string }>(
      "SELECT count(*)::text AS c FROM users",
    );
    console.log(
      `[e2e-seed] migrations applied=${result.applied} skipped=${result.skipped}; ` +
        `users=${rows[0]?.c}; admin=${ADMIN_EMAIL}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "[e2e-seed] failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
