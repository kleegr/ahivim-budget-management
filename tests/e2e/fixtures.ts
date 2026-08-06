/**
 * Shared constants for the Playwright end-to-end suite.
 *
 * Pure data, no side effects: this module is imported both by the standalone
 * `tsx` seed script and by the Playwright specs / config, so it must never pull
 * in application code or the database driver.
 */

/** Test database. `pg` (not the Neon driver) talks to this one directly. */
export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres@127.0.0.1:5432/ahivim_test";

/** Where the built application is served for the run. */
export const BASE_URL = process.env.E2E_BASE_URL || "http://127.0.0.1:3000";

/** Port the WebSocket-to-TCP bridge (scripts/ws-proxy.ts) listens on. */
export const WS_PROXY_PORT = Number(process.env.WS_PROXY_PORT || 5480);

/**
 * Admin seeded directly into the test database before the run. The password is
 * hashed with the application's own scrypt helper so the real sign-in form
 * verifies it. Must be >= 10 characters (the app's minimum).
 */
export const ADMIN_EMAIL = "e2e-admin@ahivim.test";
export const ADMIN_PASSWORD = "e2e-admin-password";
export const ADMIN_DISPLAY_NAME = "E2E Admin";
