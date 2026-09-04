/**
 * Shared constants for the Playwright end-to-end suite.
 *
 * Pure data, no side effects: this module is imported both by the standalone
 * `tsx` seed script and by the Playwright specs / config, so it must never pull
 * in application code or the database driver.
 */

/**
 * Dedicated disposable test database. The destructive seed refuses to run
 * unless this is explicitly configured; an ordinary DATABASE_URL is never a
 * safe fallback.
 */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "";

/**
 * Neon endpoints already provide their own secure WebSocket transport. The
 * development proxy is only needed when that driver has to reach a local
 * PostgreSQL TCP socket.
 */
export function shouldUseE2eWsProxy(connectionString: string): boolean {
  try {
    const hostname = new URL(connectionString).hostname.toLowerCase();
    return !(hostname === "neon.tech" || hostname.endsWith(".neon.tech"));
  } catch {
    // The destructive seed owns the actionable invalid-URL error. Retain the
    // historical local-proxy path here rather than treating it as remote.
    return true;
  }
}

/**
 * Destructive seed interlock. The expected host has to be supplied separately
 * from the connection string, so copying a production URL into
 * TEST_DATABASE_URL cannot be enough to authorize DROP SCHEMA.
 */
export const EXPECTED_DISPOSABLE_DB_HOST = process.env.E2E_EXPECTED_DB_HOST ?? "";
export const RESET_CONFIRMATION = process.env.E2E_CONFIRM_RESET ?? "";
export const RESET_CONFIRMATION_PHRASE = "DROP_DISPOSABLE_E2E_DATABASE";

/** Pure and deliberately exported so the destructive gate can be unit tested. */
export function assertSafeE2eDatabaseReset(input: {
  connectionString: string;
  expectedHost: string;
  confirmation: string;
}): void {
  if (!input.connectionString) {
    throw new Error("TEST_DATABASE_URL is required for the disposable E2E database.");
  }
  if (!input.expectedHost.trim()) {
    throw new Error("E2E_EXPECTED_DB_HOST must name the disposable database host.");
  }
  if (input.confirmation !== RESET_CONFIRMATION_PHRASE) {
    throw new Error(`E2E_CONFIRM_RESET must equal ${RESET_CONFIRMATION_PHRASE}.`);
  }

  let target: URL;
  try {
    target = new URL(input.connectionString);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use the postgres or postgresql protocol.");
  }
  if (target.hostname.toLowerCase() !== input.expectedHost.trim().toLowerCase()) {
    throw new Error("TEST_DATABASE_URL does not match E2E_EXPECTED_DB_HOST; reset refused.");
  }
  if (!target.pathname.replace(/^\/+/, "").trim()) {
    throw new Error("TEST_DATABASE_URL must name a disposable database; reset refused.");
  }
}

/** Where the built application is served for the run. */
// Match Next's canonical local origin so host-bound authentication cookies
// survive form redirects such as owner role preview.
export const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000";

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

/** Stable business records used to prove that portal scope does not widen. */
export const LINKED_INDIVIDUAL_ID = "10000000-0000-4000-8000-000000000001";
export const UNLINKED_INDIVIDUAL_ID = "10000000-0000-4000-8000-000000000002";
export const LINKED_EMPLOYEE_ID = "20000000-0000-4000-8000-000000000001";
export const UNLINKED_EMPLOYEE_ID = "20000000-0000-4000-8000-000000000002";
export const TEST_AGENCY_ID = "30000000-0000-4000-8000-000000000001";

/** Stable release-acceptance records and exact business values. */
export const DIRECT_TRANSACTION_ONE_ID = "40000000-0000-4000-8000-000000000001";
export const DIRECT_TRANSACTION_TWO_ID = "40000000-0000-4000-8000-000000000002";
export const AGENCY_TRANSACTION_ID = "40000000-0000-4000-8000-000000000003";
export const DIRECT_CHECK_NUMBER = "CHECK-E2E-001";
export const AGENCY_CHECK_NUMBER = "AGENCY-E2E-001";
export const ACTIVITY_DATE = "2026-09-04";
export const ACTIVITY_PERIOD_BEGIN = "2026-09-01";
export const ACTIVITY_PERIOD_END = "2026-09-03";
export const CURRENT_BUDGET_LABEL = "E2E Current 2026";
export const HISTORICAL_BUDGET_LABEL = "E2E Historical 2025";
export const PRIMARY_CALCULATION_ACCOUNT = "Primary Reserve";
export const SECONDARY_CALCULATION_ACCOUNT = "Secondary Reserve";
export const FUTURE_SESSION_DATE = "2026-10-15";
export const E2E_CLASS_MONTH = "2026-09";
export const E2E_CLASS_ACTIVITY_NAME = "E2E Community Class";
export const E2E_CLASS_BUDGET_LABEL = "E2E 2026 Community Classes";
export const E2E_CLASS_ISSUED_INVOICE = "E2E-CLASS-ISSUED-001";
export const E2E_CLASS_DRAFT_INVOICE = "E2E-CLASS-DRAFT-001";

export const REPRESENTATIVE_PASSWORD = "e2e-role-password";

/**
 * One real login for every persisted account preset. Keeping the expected
 * landing here makes the product's role contract executable in Playwright.
 */
export const REPRESENTATIVE_ACCOUNTS = [
  { preset: "owner", email: ADMIN_EMAIL, displayName: ADMIN_DISPLAY_NAME, expectedPath: "/dashboard", external: false },
  { preset: "office_manager", email: "office-manager@ahivim.test", displayName: "E2E Office Manager", expectedPath: "/dashboard", external: false },
  { preset: "budget_planner", email: "budget-planner@ahivim.test", displayName: "E2E Budget Planner", expectedPath: "/home", external: false },
  { preset: "staffing_manager", email: "staffing-manager@ahivim.test", displayName: "E2E Staffing Manager", expectedPath: "/home", external: false },
  { preset: "money_collector", email: "money-collector@ahivim.test", displayName: "E2E Money Collector", expectedPath: "/home", external: false },
  { preset: "class_billing", email: "class-billing@ahivim.test", displayName: "E2E Class Billing", expectedPath: "/home", external: false },
  { preset: "individual_parent", email: "parent@ahivim.test", displayName: "E2E Parent", expectedPath: "/portal", external: true },
  { preset: "employee", email: "employee@ahivim.test", displayName: "E2E Employee", expectedPath: "/portal", external: true },
  { preset: "agency", email: "agency@ahivim.test", displayName: "E2E Agency", expectedPath: "/portal", external: true },
  { preset: "agency_scheduler", email: "agency-scheduler@ahivim.test", displayName: "E2E Agency Scheduler", expectedPath: "/schedule", external: true },
  { preset: "agency_staffing_manager", email: "agency-staffing@ahivim.test", displayName: "E2E Agency Staffing Manager", expectedPath: "/schedule", external: true },
  { preset: "agency_collector", email: "agency-collector@ahivim.test", displayName: "E2E Agency Collector", expectedPath: "/portal", external: true },
  { preset: "custom_access", email: "custom-access@ahivim.test", displayName: "E2E Custom Access", expectedPath: "/home", external: false },
] as const;

export type RepresentativeAccount = (typeof REPRESENTATIVE_ACCOUNTS)[number];

export function passwordFor(account: RepresentativeAccount): string {
  return account.preset === "owner" ? ADMIN_PASSWORD : REPRESENTATIVE_PASSWORD;
}
