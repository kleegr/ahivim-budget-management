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

/** Stable business records used to prove that portal scope does not widen. */
export const LINKED_INDIVIDUAL_ID = "10000000-0000-4000-8000-000000000001";
export const UNLINKED_INDIVIDUAL_ID = "10000000-0000-4000-8000-000000000002";
export const LINKED_EMPLOYEE_ID = "20000000-0000-4000-8000-000000000001";
export const UNLINKED_EMPLOYEE_ID = "20000000-0000-4000-8000-000000000002";
export const TEST_AGENCY_ID = "30000000-0000-4000-8000-000000000001";

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
