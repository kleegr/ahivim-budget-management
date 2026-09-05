/**
 * End-to-end test seed. Standalone script, run with `tsx` from Playwright's
 * app web-server command — NOT imported by the Playwright runner.
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
import { provisionUser, type ProvisionUserInput } from "../../src/lib/auth/provision-user";
import { seedReleaseAcceptanceData } from "./release-data";
import { seedClassDocumentAcceptanceData } from "./class-document-data";
import { seedMoneyOperationsAcceptanceData } from "./money-operations-data";
import {
  TEST_DB_URL,
  EXPECTED_DISPOSABLE_DB_HOST,
  RESET_CONFIRMATION,
  assertSafeE2eDatabaseReset,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_DISPLAY_NAME,
  LINKED_INDIVIDUAL_ID,
  UNLINKED_INDIVIDUAL_ID,
  LINKED_EMPLOYEE_ID,
  UNLINKED_EMPLOYEE_ID,
  TEST_AGENCY_ID,
  REPRESENTATIVE_ACCOUNTS,
  REPRESENTATIVE_PASSWORD,
} from "./fixtures";

async function main(): Promise<void> {
  // This must run before constructing a Pool: a copied connection string alone
  // can never authorize the destructive reset below.
  assertSafeE2eDatabaseReset({
    connectionString: TEST_DB_URL,
    expectedHost: EXPECTED_DISPOSABLE_DB_HOST,
    confirmation: RESET_CONFIRMATION,
  });
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 4 });
  try {
    // A fresh deployment's schema, deterministically.
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    const result = await runMigrations(pool as unknown as PgLikePool);

    // Some historical migrations intentionally seed demo business records.
    // Playwright needs one deterministic production-shaped truth set instead:
    // clear only the disposable database's business roots and their dependent
    // rows, while retaining the migrated schema, programs, and effective rates.
    await pool.query(
      `TRUNCATE TABLE individuals, employees, agencies, imported_files CASCADE`,
    );

    // One known administrator, hashed the way the app hashes.
    const passwordHash = await hashPassword(ADMIN_PASSWORD);
    const administrator = await pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'admin', true)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             display_name = EXCLUDED.display_name,
             role = 'admin',
             account_preset = 'owner',
             is_active = true
       RETURNING id`,
      [ADMIN_EMAIL.toLowerCase(), ADMIN_DISPLAY_NAME, passwordHash],
    );
    const actorId = administrator.rows[0]!.id;
    await pool.query("UPDATE users SET account_preset = 'owner' WHERE id = $1", [actorId]);
    await pool.query(
      `INSERT INTO user_portal_roles
        (user_id, portal_role, is_active, created_by_user_id, updated_by_user_id)
       VALUES ($1, 'owner', true, $1, $1)
       ON CONFLICT (user_id, portal_role) DO UPDATE SET is_active = true`,
      [actorId],
    );

    await pool.query(
      `INSERT INTO individuals
         (id, normalized_name, display_name, external_ref, phone, category, legal_name, preferred_name, notes)
       VALUES
         ($1, 'linked-individual', 'Linked Individual', 'E2E-PERSON-001',
          '212-555-0101', 'Community supports', 'Linked Individual Legal', 'Linked',
          'Production-shaped release acceptance person'),
         ($2, 'private-individual', 'Private Unlinked Individual', 'E2E-PRIVATE-001',
          NULL, NULL, 'Private Unlinked Individual', NULL,
          'Must remain invisible to scoped portal accounts')`,
      [LINKED_INDIVIDUAL_ID, UNLINKED_INDIVIDUAL_ID],
    );
    await pool.query(
      `INSERT INTO employees (id, normalized_name, display_name, external_ref, notes)
       VALUES
         ($1, 'linked-employee', 'Linked Employee', 'E2E-WORKER-001',
          'Production-shaped release acceptance employee'),
         ($2, 'private-employee', 'Private Unlinked Employee', 'E2E-PRIVATE-WORKER-001',
          'Must remain invisible to scoped portal accounts')`,
      [LINKED_EMPLOYEE_ID, UNLINKED_EMPLOYEE_ID],
    );
    await pool.query(
      `INSERT INTO agencies
        (id, code, name, created_by_user_id, updated_by_user_id)
       VALUES ($1, 'E2E-AGENCY', 'E2E Provider Agency', $2, $2)`,
      [TEST_AGENCY_ID, actorId],
    );
    await pool.query(
      `INSERT INTO agency_individuals
        (agency_id, individual_id, manages_budget, bills_services, effective_from, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, true, true, '2026-01-01', $3, $3)`,
      [TEST_AGENCY_ID, LINKED_INDIVIDUAL_ID, actorId],
    );
    await pool.query(
      `INSERT INTO agency_employees
        (agency_id, employee_id, effective_from, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, '2026-01-01', $3, $3)`,
      [TEST_AGENCY_ID, LINKED_EMPLOYEE_ID, actorId],
    );

    for (const account of REPRESENTATIVE_ACCOUNTS) {
      if (account.preset === "owner") continue;
      const input: ProvisionUserInput = {
        preset: account.preset,
        email: account.email,
        displayName: account.displayName,
        password: REPRESENTATIVE_PASSWORD,
        reason: "Representative end-to-end acceptance account",
      };
      if (account.preset === "individual_parent") {
        input.individualId = LINKED_INDIVIDUAL_ID;
        input.relationship = "parent";
      } else if (account.preset === "employee") {
        input.employeeId = LINKED_EMPLOYEE_ID;
      } else if (account.preset.startsWith("agency")) {
        input.agencyId = TEST_AGENCY_ID;
      }
      const provisioned = await provisionUser(
        pool as unknown as PgLikePool,
        input,
        actorId,
      );
      if (!provisioned.ok) {
        throw new Error(`Could not provision ${account.preset}: ${provisioned.message}`);
      }
    }

    const releaseData = await seedReleaseAcceptanceData(
      pool as unknown as PgLikePool,
      actorId,
    );
    await seedClassDocumentAcceptanceData(pool as unknown as PgLikePool, actorId);
    const moneyData = await seedMoneyOperationsAcceptanceData(
      pool as unknown as PgLikePool,
      actorId,
    );

    const { rows } = await pool.query<{ c: string }>(
      "SELECT count(*)::text AS c FROM users",
    );
    console.log(
      `[e2e-seed] migrations applied=${result.applied} skipped=${result.skipped}; ` +
        `users=${rows[0]?.c}; representative-presets=${REPRESENTATIVE_ACCOUNTS.length}; ` +
        `transactions=${releaseData.transactions}; strategies=${releaseData.strategies}; ` +
        `sessions=${releaseData.sessions}; obligations=${releaseData.obligations}; ` +
        `class-invoices=3; money-obligation=${moneyData.obligationId}; ` +
        `money-reserve=${moneyData.reserveObligationId}; ` +
        `class-receipt=${moneyData.classReceiptId}`,
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
