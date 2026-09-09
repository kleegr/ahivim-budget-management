import { assertSafeE2eDatabaseReset, RESET_CONFIRMATION_PHRASE } from "../e2e/fixtures";

/** Check the parsed host AND database name before any destructive SQL. */
export function assertSafeTestDatabase(input: {
  connectionString: string; expectedHost: string; expectedDatabase: string; confirmation: string;
}): void {
  assertSafeE2eDatabaseReset({
    connectionString: input.connectionString,
    expectedHost: input.expectedHost,
    confirmation: input.confirmation === "DROP_DISPOSABLE_TEST_DATABASE" ? RESET_CONFIRMATION_PHRASE : "",
  });
  const target = new URL(input.connectionString);
  if (!input.expectedDatabase || decodeURIComponent(target.pathname.slice(1)) !== input.expectedDatabase) {
    throw new Error("TEST_DATABASE_URL does not match TEST_EXPECTED_DB_NAME; reset refused.");
  }
}
