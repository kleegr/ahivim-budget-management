import { describe, expect, it } from "vitest";
import {
  RESET_CONFIRMATION_PHRASE,
  assertSafeE2eDatabaseReset,
  shouldUseE2eWsProxy,
} from "./fixtures";

const disposableUrl = "postgresql://test:test@disposable-db.example.test:5432/ahivim_e2e";

function assertReset(overrides: Partial<Parameters<typeof assertSafeE2eDatabaseReset>[0]> = {}): void {
  assertSafeE2eDatabaseReset({
    connectionString: disposableUrl,
    expectedHost: "disposable-db.example.test",
    confirmation: RESET_CONFIRMATION_PHRASE,
    ...overrides,
  });
}

describe("E2E destructive database reset interlock", () => {
  it("accepts the exact separately confirmed disposable host", () => {
    expect(() => assertReset()).not.toThrow();
  });

  it("rejects a host mismatch without disclosing the connection URL", () => {
    expect(() => assertReset({ expectedHost: "production-db.example.test" })).toThrow(
      "TEST_DATABASE_URL does not match E2E_EXPECTED_DB_HOST; reset refused.",
    );
  });

  it("rejects a missing explicit confirmation", () => {
    expect(() => assertReset({ confirmation: "" })).toThrow(
      `E2E_CONFIRM_RESET must equal ${RESET_CONFIRMATION_PHRASE}.`,
    );
  });

  it("rejects non-PostgreSQL URLs and URLs without a database name", () => {
    expect(() => assertReset({ connectionString: "https://disposable-db.example.test/ahivim_e2e" })).toThrow(
      "TEST_DATABASE_URL must use the postgres or postgresql protocol.",
    );
    expect(() => assertReset({ connectionString: "postgresql://test:test@disposable-db.example.test/" })).toThrow(
      "TEST_DATABASE_URL must name a disposable database; reset refused.",
    );
  });
});

describe("E2E database transport", () => {
  it("uses Neon directly and retains the proxy for local PostgreSQL", () => {
    expect(shouldUseE2eWsProxy(
      "postgresql://user:secret@ep-example-pooler.us-east-2.aws.neon.tech/test?sslmode=require",
    )).toBe(false);
    expect(shouldUseE2eWsProxy("postgresql://postgres@127.0.0.1:5432/ahivim_test")).toBe(true);
    expect(shouldUseE2eWsProxy("postgresql://postgres@localhost:5432/ahivim_test")).toBe(true);
  });
});
