import { describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./support/database-safety";

const safe = { connectionString: "postgres://test:test@127.0.0.1:55432/ahivim_test", expectedHost: "127.0.0.1", expectedDatabase: "ahivim_test", confirmation: "DROP_DISPOSABLE_TEST_DATABASE" };
describe("unit/integration test database reset guard", () => {
  it("accepts only the separately confirmed destination", () => expect(() => assertSafeTestDatabase(safe)).not.toThrow());
  it.each([
    { expectedHost: "production.example.com" }, { expectedDatabase: "production" }, { confirmation: "" },
    { connectionString: `${safe.connectionString}?HOST=production.example.com` },
    { connectionString: `${safe.connectionString}?database=production` },
  ])("rejects target drift before connecting", override => expect(() => assertSafeTestDatabase({ ...safe, ...override })).toThrow());
});
