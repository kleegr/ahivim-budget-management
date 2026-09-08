import { assertSafeE2eDatabaseReset } from "./fixtures";

export function assertSyntheticSourceEnvironment(env: Record<string, string | undefined>): void {
  if (env.AHIVIM_E2E_SOURCE_PRELOAD !== "ALLOW_SYNTHETIC_SHEET_READ"
    || !env.DATABASE_URL || env.DATABASE_URL !== env.TEST_DATABASE_URL) {
    throw new Error("Synthetic source transport requires the explicitly selected disposable test database.");
  }
  assertSafeE2eDatabaseReset({ connectionString: env.TEST_DATABASE_URL,
    expectedHost: env.E2E_EXPECTED_DB_HOST ?? "", confirmation: env.E2E_CONFIRM_RESET ?? "" });
}

/** Only the existing pinned inbound CSV read can receive the synthetic source. */
export function assertSyntheticSourceRequest(rawUrl: string, method: string): void {
  const url = new URL(rawUrl);
  if (method.toUpperCase() !== "GET" || url.protocol !== "https:" || url.hostname !== "docs.google.com"
    || url.username || url.password || url.port || url.hash
    || url.pathname !== "/spreadsheets/d/1UtpmJE98pfMVWbbSNsn4ahPYvQUm9k5Kpfxj8nFGguk/export"
    || [...url.searchParams].length !== 2 || url.searchParams.get("format") !== "csv"
    || url.searchParams.get("gid") !== "1743235610") {
    throw new Error("Synthetic source transport permits only the exact read-only CSV request.");
  }
}
